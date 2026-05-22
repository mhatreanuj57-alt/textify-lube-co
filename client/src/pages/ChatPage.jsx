import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import CallOverlay from '@/components/Call/CallOverlay';
import ChatWindow from '@/components/Chat/ChatWindow';
import Sidebar from '@/components/Sidebar/Sidebar';
import Spinner from '@/components/Shared/Spinner';
import useCall from '@/hooks/useCall';
import useConversations from '@/hooks/useConversations';
import usePresence from '@/hooks/usePresence';
import { useAuth } from '@/hooks/useAuth';
import styles from './ChatPage.module.css';

export default function ChatPage() {
  const navigate = useNavigate();
  const { conversationId } = useParams();
  const { user, profile, loading: authLoading, profileResolved, signOut } = useAuth();
  const { conversations, loading } = useConversations();
  const { presenceMap } = usePresence();
  const [search, setSearch] = useState('');
  const [isWindowFocused, setIsWindowFocused] = useState(true);
  const effectiveProfile = profile ?? {
    id: user?.id,
    user_id: user?.id,
    email: user?.email || '',
    display_name:
      user?.user_metadata?.display_name ||
      user?.user_metadata?.full_name ||
      user?.email?.split('@')[0] ||
      'Textify user',
    username: user?.user_metadata?.user_name || user?.user_metadata?.preferred_username || '',
    avatar_url: user?.user_metadata?.avatar_url || '',
  };

  const call = useCall({
    currentUserId: user?.id,
    currentProfile: effectiveProfile,
  });

  useEffect(() => {
    const handleFocus = () => setIsWindowFocused(true);
    const handleBlur = () => setIsWindowFocused(false);

    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);
    
    const handleContextMenu = (e) => {
      if (e.target.tagName === 'IMG' || e.target.closest('[class*="bubble"]')) {
        e.preventDefault();
      }
    };
    window.addEventListener('contextmenu', handleContextMenu);

    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('contextmenu', handleContextMenu);
    };
  }, []);

  const hydratedConversations = useMemo(
    () =>
      conversations.map((conversation) => {
        const livePresence = presenceMap[conversation.otherUserId];
        return {
          ...conversation,
          is_online: livePresence?.is_online ?? conversation.is_online,
          last_seen: livePresence?.last_seen ?? conversation.last_seen,
        };
      }),
    [conversations, presenceMap],
  );

  const filteredConversations = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) {
      return hydratedConversations;
    }

    return hydratedConversations.filter((conversation) => {
      const name = conversation.display_name?.toLowerCase() || '';
      const username = conversation.username?.toLowerCase() || '';
      return name.includes(needle) || username.includes(needle);
    });
  }, [hydratedConversations, search]);

  const activeConversation =
    hydratedConversations.find((conversation) => conversation.id === conversationId) || null;

  const openConversation = (conversation) => {
    navigate(`/chat/${conversation.id}`);
  };

  const startCall = async (type, conversation = activeConversation) => {
    if (!conversation) {
      return;
    }

    await call.startCall(conversation, type);
  };

  if (authLoading || !user) {
    return <Spinner fullscreen label="Loading your chats..." />;
  }

  return (
    <>
      <main className={`${styles.page} ${!isWindowFocused ? styles.privacyBlur : ''}`}>
        <div className={`${styles.sidebarPane} ${activeConversation ? styles.mobileHidden : ''}`}>
          <Sidebar
            profile={effectiveProfile}
            searchValue={search}
            onSearchChange={setSearch}
            conversations={filteredConversations}
            activeConversationId={activeConversation?.id}
            onSelectConversation={openConversation}
            loading={loading}
            onSignOut={signOut}
            onQuickCall={() => startCall('video')}
          />
        </div>

        <div className={`${styles.chatPane} ${!activeConversation ? styles.mobileHiddenChat : ''}`}>
          {loading && !activeConversation ? (
            <Spinner label="Loading conversations..." />
          ) : (
            <ChatWindow
              conversation={activeConversation}
              currentUserId={user.id}
              showMobileBack={Boolean(activeConversation)}
              onBack={() => navigate('/chat')}
              onStartAudioCall={() => startCall('audio')}
              onStartVideoCall={() => startCall('video')}
            />
          )}
        </div>
      </main>

      {!isWindowFocused && (
        <div className={styles.privacyOverlay}>
          <div className={styles.privacyContent}>
            <h2>Privacy Mode Active</h2>
            <p>Content is hidden for your security. Click here to continue.</p>
          </div>
        </div>
      )}

      <CallOverlay
        session={call.callSession}
        localStream={call.localStream}
        remoteStream={call.remoteStream}
        isMuted={call.isMuted}
        isCameraEnabled={call.isCameraEnabled}
        onAccept={call.acceptCall}
        onReject={call.rejectCall}
        onEnd={() => call.endCall()}
        onDismiss={call.dismissCall}
        onToggleMute={call.toggleMute}
        onToggleCamera={call.toggleCamera}
      />
      {!profileResolved ? <Spinner label="Syncing profile..." /> : null}
    </>
  );
}
