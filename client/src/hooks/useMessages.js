import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { sanitizeFileName } from '@/lib/chat';
import { useAuth } from '@/hooks/useAuth';

const MESSAGE_CACHE_KEY = 'textify.messages';

function readCachedMessages(conversationId) {
  if (typeof window === 'undefined' || !conversationId) {
    return [];
  }

  try {
    const raw = window.sessionStorage.getItem(`${MESSAGE_CACHE_KEY}:${conversationId}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCachedMessages(conversationId, messages) {
  if (typeof window === 'undefined' || !conversationId) {
    return;
  }

  try {
    if (!messages?.length) {
      window.sessionStorage.removeItem(`${MESSAGE_CACHE_KEY}:${conversationId}`);
      return;
    }

    window.sessionStorage.setItem(`${MESSAGE_CACHE_KEY}:${conversationId}`, JSON.stringify(messages.slice(-50)));
  } catch {
    // Ignore storage errors.
  }
}

function mergeById(currentMessages, incomingMessage) {
  if (currentMessages.some((message) => message.id === incomingMessage.id)) {
    return currentMessages;
  }

  return [...currentMessages, incomingMessage].sort(
    (a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0),
  );
}

function mergeUpdateById(currentMessages, updatedMessage) {
  return currentMessages.map((message) =>
    message.id === updatedMessage.id ? { ...message, ...updatedMessage } : message,
  );
}

export default function useMessages(conversationId) {
  const { user } = useAuth();
  const [messages, setMessages] = useState(() => readCachedMessages(conversationId));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const updateMessages = useCallback((updater) => {
    setMessages((current) => {
      const nextMessages = typeof updater === 'function' ? updater(current) : updater;
      writeCachedMessages(conversationId, nextMessages);
      return nextMessages;
    });
  }, [conversationId]);

  const loadMessages = useCallback(async () => {
    if (!conversationId) {
      updateMessages([]);
      setLoading(false);
      return;
    }

    const cachedMessages = readCachedMessages(conversationId);
    if (cachedMessages.length) {
      updateMessages(cachedMessages);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError('');

    try {
      const { data, error: queryError } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (queryError) {
        throw queryError;
      }

      updateMessages((data ?? []).reverse());
    } catch {
      setError('Unable to load messages right now.');
    } finally {
      setLoading(false);
    }
  }, [conversationId, updateMessages]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    if (!conversationId) {
      return undefined;
    }

    const channel = supabase
      .channel(`messages:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          updateMessages((current) => mergeById(current, payload.new));
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          updateMessages((current) => mergeUpdateById(current, payload.new));
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  const sendMessage = useCallback(
    async ({ text = '', file = null, isViewOnce = false }) => {
      if (!conversationId || !user?.id || (!text.trim() && !file)) {
        return { error: 'Message is empty.' };
      }

      const localPreviewUrl = file ? URL.createObjectURL(file) : null;
      let mediaUrl = null;
      let fileName = null;
      let fileSize = null;
      let baseType = file ? (file.type.startsWith('image/') ? 'image' : 'file') : 'text';
      let messageType = isViewOnce && file ? `view-once:${baseType}` : baseType;

      const optimisticMessage = {
        id: `optimistic-${Date.now()}`,
        conversation_id: conversationId,
        sender_id: user.id,
        content: text.trim(),
        message_type: messageType,
        media_url: localPreviewUrl,
        file_name: file?.name ?? null,
        file_size: file?.size ?? null,
        status: 'sent',
        created_at: new Date().toISOString(),
        optimistic: true,
      };

      updateMessages((current) => [...current, optimisticMessage]);

      if (file) {
        messageType = file.type.startsWith('image/') ? 'image' : 'file';
        fileName = file.name;
        fileSize = file.size;

        const filePath = `${user.id}/${conversationId}/${Date.now()}-${sanitizeFileName(file.name)}`;
        const { error: uploadError } = await supabase.storage.from('chat-media').upload(filePath, file, {
          upsert: false,
        });

        if (uploadError) {
          if (localPreviewUrl) {
            URL.revokeObjectURL(localPreviewUrl);
          }
          updateMessages((current) => current.filter((message) => message.id !== optimisticMessage.id));
          return { error: uploadError.message || 'Unable to upload file.' };
        }

        const {
          data: { publicUrl },
        } = supabase.storage.from('chat-media').getPublicUrl(filePath);

        mediaUrl = publicUrl;
      }

      try {
        const payload = {
          conversation_id: conversationId,
          sender_id: user.id,
          content: text.trim(),
          message_type: messageType,
          media_url: mediaUrl,
          file_name: fileName,
          file_size: fileSize,
          status: 'sent',
        };

        const { data, error: insertError } = await supabase
          .from('messages')
          .insert(payload)
          .select()
          .single();

        if (insertError) {
          throw insertError;
        }

        if (localPreviewUrl) {
          URL.revokeObjectURL(localPreviewUrl);
        }

        updateMessages((current) =>
          current
            .filter((message) => message.id !== optimisticMessage.id)
            .concat(data)
            .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0)),
        );

        try {
          await supabase
            .from('conversations')
            .update({
              updated_at: new Date().toISOString(),
            })
            .eq('id', conversationId);
        } catch {
          return { data, error: null };
        }

        return { data, error: null };
      } catch (sendError) {
        if (localPreviewUrl) {
          URL.revokeObjectURL(localPreviewUrl);
        }
        updateMessages((current) => current.filter((message) => message.id !== optimisticMessage.id));
        return { error: sendError.message || 'Unable to send message.' };
      }
    },
    [conversationId, updateMessages, user?.id],
  );

  return useMemo(
    () => ({
      messages,
      loading,
      error,
      sendMessage,
      refreshMessages: loadMessages,
    }),
    [error, loadMessages, loading, messages, sendMessage],
  );
}
