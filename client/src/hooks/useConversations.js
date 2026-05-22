import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { buildMessagePreview, getProfileId } from '@/lib/chat';
import { useAuth } from '@/hooks/useAuth';

function normalizeConversation({
  conversation,
  participant,
  otherProfile,
  latestMessage,
  unreadCount,
}) {
  return {
    ...conversation,
    id: conversation.id,
    otherUserId: participant?.user_id ?? participant?.id ?? otherProfile?.user_id ?? otherProfile?.id,
    display_name:
      otherProfile?.display_name || otherProfile?.username || otherProfile?.email || 'Unknown contact',
    username: otherProfile?.username || 'unknown',
    avatar_url: otherProfile?.avatar_url || '',
    is_online: Boolean(otherProfile?.is_online),
    last_seen: otherProfile?.last_seen || null,
    last_message: latestMessage,
    last_message_preview: buildMessagePreview(latestMessage),
    last_message_at: latestMessage?.created_at || conversation.updated_at || conversation.created_at,
    unread_count: unreadCount,
    status: latestMessage?.status || 'sent',
  };
}

export default function useConversations() {
  const { user } = useAuth();
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  const hydrateConversationMetadata = useCallback(async (conversationIds, userId, requestId = requestRef.current) => {
    if (!conversationIds.length || !userId) {
      return;
    }

    try {
      const messagePromises = conversationIds.map((id) =>
        supabase
          .from('messages')
          .select('id, conversation_id, sender_id, content, message_type, status, created_at, file_name')
          .eq('conversation_id', id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      );

      const unreadPromises = conversationIds.map((id) =>
        supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', id)
          .neq('sender_id', userId)
          .in('status', ['sent', 'delivered']),
      );

      const [messageResults, unreadResults] = await Promise.all([
        Promise.all(messagePromises),
        Promise.all(unreadPromises),
      ]);

      if (requestId !== requestRef.current) {
        return;
      }

      const latestMessageMap = new Map(
        messageResults
          .map((result) => result.data)
          .filter(Boolean)
          .map((message) => [message.conversation_id, message]),
      );

      const unreadMap = new Map(
        unreadResults.map((result, index) => [conversationIds[index], result.count ?? 0]),
      );

      setConversations((current) =>
        current
          .map((conversation) => {
            if (!latestMessageMap.has(conversation.id) && !unreadMap.has(conversation.id)) {
              return conversation;
            }

            const latestMessage = latestMessageMap.get(conversation.id) ?? conversation.last_message ?? null;
            const unreadCount = unreadMap.get(conversation.id) ?? conversation.unread_count ?? 0;

            return {
              ...conversation,
              last_message: latestMessage,
              last_message_preview: buildMessagePreview(latestMessage),
              last_message_at: latestMessage?.created_at || conversation.updated_at || conversation.created_at,
              unread_count: unreadCount,
              status: latestMessage?.status || conversation.status || 'sent',
            };
          })
          .sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0)),
      );
    } catch {
      // Keep the fast conversation shell visible even if metadata hydration fails.
    }
  }, []);

  const loadConversations = useCallback(async () => {
    const requestId = ++requestRef.current;

    if (!user?.id) {
      setConversations([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');

    try {
      const { data: membershipRows, error: membershipError } = await supabase
        .from('conversation_participants')
        .select('conversation_id, user_id')
        .eq('user_id', user.id);

      if (membershipError) {
        throw membershipError;
      }

      const conversationIds = [...new Set((membershipRows ?? []).map((item) => item.conversation_id))];

      if (!conversationIds.length) {
        setConversations([]);
        return;
      }

      const [
        { data: conversationRows, error: conversationsError },
        { data: participantRows, error: participantsError },
      ] = await Promise.all([
        supabase.from('conversations').select('id, created_at, updated_at').in('id', conversationIds),
        supabase.from('conversation_participants').select('conversation_id, user_id').in('conversation_id', conversationIds),
      ]);

      if (conversationsError) throw conversationsError;
      if (participantsError) throw participantsError;

      const otherParticipants = (participantRows ?? []).filter((participant) => participant.user_id !== user.id);
      const otherUserIds = [...new Set(otherParticipants.map((participant) => participant.user_id).filter(Boolean))];

      let profileRows = [];
      let profilesError = null;

      if (otherUserIds.length) {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, user_id, display_name, username, avatar_url, is_online, last_seen')
          .in('id', otherUserIds);

        profileRows = data ?? [];
        profilesError = error;

        const foundIds = new Set(profileRows.map((profile) => getProfileId(profile)));
        const missingIds = otherUserIds.filter((id) => !foundIds.has(id));

        if (missingIds.length) {
          try {
            const { data: altData, error: altError } = await supabase
              .from('profiles')
              .select('id, user_id, display_name, username, avatar_url, is_online, last_seen')
              .in('user_id', missingIds);

            if (!altError && altData) {
              profileRows = [...profileRows, ...altData];
            }
          } catch {
            // Ignore missing user_id column.
          }
        }
      }

      if (profilesError) {
        throw profilesError;
      }

      const profileMap = new Map((profileRows ?? []).map((profile) => [getProfileId(profile), profile]));

      const items = (conversationRows ?? [])
        .map((conversation) => {
          const participant = otherParticipants.find((item) => item.conversation_id === conversation.id);

          return normalizeConversation({
            conversation,
            participant,
            otherProfile: profileMap.get(participant?.user_id),
            latestMessage: null,
            unreadCount: 0,
          });
        })
        .sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0));

      if (requestId !== requestRef.current) {
        return;
      }

      setConversations(items);
      void hydrateConversationMetadata(conversationIds, user.id, requestId);
    } catch {
      setError('Unable to load conversations right now.');
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false);
      }
    }
  }, [hydrateConversationMetadata, user?.id]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (!user?.id) {
      return undefined;
    }

    const applyMessageInsert = (message) => {
      if (!message?.conversation_id) {
        return;
      }

      setConversations((current) => {
        if (!current.some((conversation) => conversation.id === message.conversation_id)) {
          return current;
        }

        return current
          .map((conversation) => {
            if (conversation.id !== message.conversation_id) {
              return conversation;
            }

            const unreadDelta =
              message.sender_id !== user.id && ['sent', 'delivered'].includes(message.status) ? 1 : 0;

            return {
              ...conversation,
              last_message: message,
              last_message_preview: buildMessagePreview(message),
              last_message_at: message.created_at || conversation.last_message_at,
              unread_count: conversation.unread_count + unreadDelta,
              status: message.status || conversation.status,
            };
          })
          .sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0));
      });
    };

    const applyMessageUpdate = (message) => {
      if (!message?.id) {
        return;
      }

      setConversations((current) =>
        current.map((conversation) =>
          conversation.last_message?.id === message.id
            ? {
                ...conversation,
                last_message: message,
                last_message_preview: buildMessagePreview(message),
                last_message_at: message.created_at || conversation.last_message_at,
                status: message.status || conversation.status,
              }
            : conversation,
        ),
      );
    };

    const applyProfileUpdate = (profile) => {
      const profileId = getProfileId(profile);

      if (!profileId) {
        return;
      }

      setConversations((current) =>
        current.map((conversation) =>
          conversation.otherUserId === profileId
            ? {
                ...conversation,
                display_name: profile.display_name || profile.username || conversation.display_name,
                username: profile.username || conversation.username,
                avatar_url: profile.avatar_url || conversation.avatar_url,
                is_online: Boolean(profile.is_online),
                last_seen: profile.last_seen || conversation.last_seen,
              }
            : conversation,
        ),
      );
    };

    const channel = supabase
      .channel(`conversations:${user.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        applyMessageInsert(payload.new);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
        applyMessageUpdate(payload.new);
      })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversation_participants', filter: `user_id=eq.${user.id}` },
        () => {
          void loadConversations();
        },
      )
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (payload) => {
        applyProfileUpdate(payload.new);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadConversations, user?.id]);

  return useMemo(
    () => ({
      conversations,
      loading,
      error,
      refreshConversations: loadConversations,
    }),
    [conversations, error, loadConversations, loading],
  );
}
