import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

const TERMINAL_STATUSES = new Set(['ended', 'rejected', 'error']);
const CHANNEL_TIMEOUT_MS = 10000;
let simplePeerPromise;

async function getSimplePeer() {
  if (!simplePeerPromise) {
    simplePeerPromise = import('simple-peer').then((module) => module.default);
  }

  return simplePeerPromise;
}

function getIceServers() {
  const defaultServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const turnUrls = import.meta.env.VITE_TURN_URLS || import.meta.env.VITE_TURN_URL;
  const username = import.meta.env.VITE_TURN_USERNAME;
  const credential = import.meta.env.VITE_TURN_CREDENTIAL;

  if (!turnUrls || !username || !credential) {
    return defaultServers;
  }

  return [
    ...defaultServers,
    {
      urls: turnUrls.split(',').map((value) => value.trim()).filter(Boolean),
      username,
      credential,
    },
  ];
}

function buildChannelName(userId) {
  return `calls:${userId}`;
}

export default function useCall({ currentUserId, currentProfile }) {
  const [callSession, setCallSession] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraEnabled, setIsCameraEnabled] = useState(true);

  const callSessionRef = useRef(null);
  const peerRef = useRef(null);
  const inboundChannelRef = useRef(null);
  const outboundChannelsRef = useRef(new Map());
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const closingPeerRef = useRef(false);

  useEffect(() => {
    callSessionRef.current = callSession;
  }, [callSession]);

  const releaseStream = useCallback((stream) => {
    stream?.getTracks?.().forEach((track) => track.stop());
  }, []);

  const clearMedia = useCallback(() => {
    releaseStream(localStreamRef.current);
    releaseStream(remoteStreamRef.current);
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setIsMuted(false);
    setIsCameraEnabled(true);
  }, [releaseStream]);

  const clearPeer = useCallback(() => {
    if (!peerRef.current) {
      return;
    }

    closingPeerRef.current = true;
    peerRef.current.destroy();
    peerRef.current = null;
  }, []);

  const clearCall = useCallback(
    ({ keepSession = false } = {}) => {
      clearPeer();
      clearMedia();

      if (!keepSession) {
        setCallSession(null);
      }
    },
    [clearMedia, clearPeer],
  );

  const ensureOutboundChannel = useCallback(async (targetUserId) => {
    const existing = outboundChannelsRef.current.get(targetUserId);

    if (existing?.status === 'subscribed') {
      return existing.channel;
    }

    if (existing?.promise) {
      return existing.promise;
    }

    const channel = supabase.channel(buildChannelName(targetUserId), {
      config: {
        broadcast: { self: false },
      },
    });

    const promise = new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        outboundChannelsRef.current.delete(targetUserId);
        supabase.removeChannel(channel);
        reject(new Error('Timed out connecting to the call channel.'));
      }, CHANNEL_TIMEOUT_MS);

      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          window.clearTimeout(timeoutId);
          outboundChannelsRef.current.set(targetUserId, {
            channel,
            status: 'subscribed',
          });
          resolve(channel);
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          window.clearTimeout(timeoutId);
          outboundChannelsRef.current.delete(targetUserId);
          supabase.removeChannel(channel);
          reject(new Error('Unable to connect to call signaling.'));
        }
      });
    });

    outboundChannelsRef.current.set(targetUserId, {
      channel,
      status: 'joining',
      promise,
    });

    return promise;
  }, []);

  const sendSignal = useCallback(
    async (targetUserId, event, payload) => {
      if (!targetUserId) {
        return;
      }

      const channel = await ensureOutboundChannel(targetUserId);
      await channel.send({
        type: 'broadcast',
        event,
        payload,
      });
    },
    [ensureOutboundChannel],
  );

  const syncAudioTrack = useCallback((nextMuted) => {
    localStreamRef.current?.getAudioTracks?.().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
  }, []);

  const syncVideoTrack = useCallback((nextEnabled) => {
    localStreamRef.current?.getVideoTracks?.().forEach((track) => {
      track.enabled = nextEnabled;
    });
    setIsCameraEnabled(nextEnabled);
  }, []);

  const createPeer = useCallback(
    async ({ initiator, stream, targetUserId, conversationId, callType, initialSignal, metadata }) => {
      const SimplePeer = await getSimplePeer();
      const peer = new SimplePeer({
        initiator,
        trickle: true,
        stream,
        config: {
          iceServers: getIceServers(),
        },
      });

      peer.on('signal', (data) => {
        if (data.type === 'offer') {
          void sendSignal(targetUserId, 'incoming_call', {
            callerId: currentUserId,
            conversationId,
            callType,
            sdp: data,
            caller: metadata,
          });
          return;
        }

        if (data.type === 'answer') {
          void sendSignal(targetUserId, 'sdp_signal', {
            fromUserId: currentUserId,
            conversationId,
            sdp: data,
          });
          return;
        }

        void sendSignal(targetUserId, 'ice_candidate', {
          fromUserId: currentUserId,
          conversationId,
          candidate: data,
        });
      });

      peer.on('stream', (nextRemoteStream) => {
        remoteStreamRef.current = nextRemoteStream;
        setRemoteStream(nextRemoteStream);
        setCallSession((current) => (current ? { ...current, status: 'connected' } : current));
      });

      peer.on('close', () => {
        const wasIntentional = closingPeerRef.current;
        closingPeerRef.current = false;
        peerRef.current = null;

        if (!wasIntentional) {
          clearMedia();
          setCallSession((current) =>
            current ? { ...current, status: 'ended', reason: 'Call ended.' } : current,
          );
        }
      });

      peer.on('error', () => {
        clearCall({ keepSession: true });
        setCallSession((current) =>
          current ? { ...current, status: 'error', reason: 'Call connection failed.' } : current,
        );
      });

      if (initialSignal) {
        peer.signal(initialSignal);
      }

      return peer;
    },
    [clearCall, clearMedia, currentUserId, sendSignal],
  );

  const requestMedia = useCallback(async (callType) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video',
    });

    localStreamRef.current = stream;
    setLocalStream(stream);
    setRemoteStream(null);
    remoteStreamRef.current = null;
    setIsMuted(false);
    syncVideoTrack(callType === 'video');

    return stream;
  }, [syncVideoTrack]);

  const startCall = useCallback(
    async (conversation, callType = 'video') => {
      if (!currentUserId || !conversation?.otherUserId) {
        return;
      }

      if (callSessionRef.current && !TERMINAL_STATUSES.has(callSessionRef.current.status)) {
        return;
      }

      try {
        const stream = await requestMedia(callType);

        const session = {
          status: 'calling',
          direction: 'outgoing',
          type: callType,
          userId: conversation.otherUserId,
          conversationId: conversation.id,
          display_name: conversation.display_name,
          username: conversation.username,
          avatar_url: conversation.avatar_url,
          reason: '',
        };

        setCallSession(session);

        peerRef.current = await createPeer({
          initiator: true,
          stream,
          targetUserId: conversation.otherUserId,
          conversationId: conversation.id,
          callType,
          metadata: {
            display_name:
              currentProfile?.display_name || currentProfile?.username || currentProfile?.email || 'Textify user',
            username: currentProfile?.username || '',
            avatar_url: currentProfile?.avatar_url || '',
          },
        });
      } catch (error) {
        clearCall({ keepSession: true });
        setCallSession({
          status: 'error',
          direction: 'outgoing',
          type: callType,
          userId: conversation.otherUserId,
          conversationId: conversation.id,
          display_name: conversation.display_name,
          username: conversation.username,
          avatar_url: conversation.avatar_url,
          reason: error.message || 'Unable to access your camera or microphone.',
        });
      }
    },
    [clearCall, createPeer, currentProfile, currentUserId, requestMedia],
  );

  const acceptCall = useCallback(async () => {
    const incoming = callSessionRef.current;

    if (!incoming || incoming.status !== 'incoming') {
      return;
    }

    try {
      const stream = await requestMedia(incoming.type);
      setCallSession((current) => (current ? { ...current, status: 'connecting', reason: '' } : current));

      const peer = await createPeer({
        initiator: false,
        stream,
        targetUserId: incoming.userId,
        conversationId: incoming.conversationId,
        callType: incoming.type,
        initialSignal: incoming.initialSignal,
        metadata: {
          display_name:
            currentProfile?.display_name || currentProfile?.username || currentProfile?.email || 'Textify user',
          username: currentProfile?.username || '',
          avatar_url: currentProfile?.avatar_url || '',
        },
      });

      peerRef.current = peer;

      await sendSignal(incoming.userId, 'call_accepted', {
        fromUserId: currentUserId,
        conversationId: incoming.conversationId,
        callType: incoming.type,
      });
    } catch (error) {
      clearCall({ keepSession: true });
      setCallSession((current) =>
        current
          ? { ...current, status: 'error', reason: error.message || 'Unable to access your camera or microphone.' }
          : current,
      );
    }
  }, [clearCall, createPeer, currentProfile, currentUserId, requestMedia, sendSignal]);

  const rejectCall = useCallback(async () => {
    const incoming = callSessionRef.current;

    if (!incoming) {
      return;
    }

    try {
      if (incoming.userId) {
        await sendSignal(incoming.userId, 'call_rejected', {
          fromUserId: currentUserId,
          reason: 'Call declined.',
        });
      }
    } finally {
      clearCall();
    }
  }, [clearCall, currentUserId, sendSignal]);

  const endCall = useCallback(
    async ({ notify = true } = {}) => {
      const activeCall = callSessionRef.current;

      if (!activeCall) {
        return;
      }

      try {
        if (notify && activeCall.userId && !TERMINAL_STATUSES.has(activeCall.status)) {
          await sendSignal(activeCall.userId, 'call_ended', {
            fromUserId: currentUserId,
            conversationId: activeCall.conversationId,
          });
        }
      } finally {
        clearCall();
      }
    },
    [clearCall, currentUserId, sendSignal],
  );

  const dismissCall = useCallback(() => {
    clearCall();
  }, [clearCall]);

  const toggleMute = useCallback(() => {
    syncAudioTrack(!isMuted);
  }, [isMuted, syncAudioTrack]);

  const toggleCamera = useCallback(() => {
    const nextValue = !isCameraEnabled;
    syncVideoTrack(nextValue);
  }, [isCameraEnabled, syncVideoTrack]);

  useEffect(() => {
    if (!currentUserId) {
      return undefined;
    }

    const inboundChannel = supabase.channel(buildChannelName(currentUserId), {
      config: {
        broadcast: { self: false },
      },
    });

    inboundChannel
      .on('broadcast', { event: 'incoming_call' }, async ({ payload }) => {
        const activeCall = callSessionRef.current;

        if (activeCall && !TERMINAL_STATUSES.has(activeCall.status)) {
          try {
            await sendSignal(payload.callerId, 'call_rejected', {
              fromUserId: currentUserId,
              reason: 'User is busy on another call.',
            });
          } catch {
            return;
          }
          return;
        }

        setCallSession({
          status: 'incoming',
          direction: 'incoming',
          type: payload.callType || 'audio',
          userId: payload.callerId,
          conversationId: payload.conversationId || null,
          display_name: payload.caller?.display_name || 'Textify user',
          username: payload.caller?.username || '',
          avatar_url: payload.caller?.avatar_url || '',
          initialSignal: payload.sdp,
          reason: '',
        });
      })
      .on('broadcast', { event: 'call_accepted' }, () => {
        setCallSession((current) => (current ? { ...current, status: 'connecting', reason: '' } : current));
      })
      .on('broadcast', { event: 'call_rejected' }, ({ payload }) => {
        clearCall({ keepSession: true });
        setCallSession((current) =>
          current ? { ...current, status: 'rejected', reason: payload?.reason || 'Call declined.' } : current,
        );
      })
      .on('broadcast', { event: 'call_ended' }, () => {
        clearCall({ keepSession: true });
        setCallSession((current) =>
          current ? { ...current, status: 'ended', reason: 'Call ended.' } : current,
        );
      })
      .on('broadcast', { event: 'ice_candidate' }, ({ payload }) => {
        if (payload?.fromUserId !== callSessionRef.current?.userId || !peerRef.current) {
          return;
        }

        peerRef.current.signal(payload.candidate);
      })
      .on('broadcast', { event: 'sdp_signal' }, ({ payload }) => {
        if (payload?.fromUserId !== callSessionRef.current?.userId || !peerRef.current) {
          return;
        }

        peerRef.current.signal(payload.sdp);
      });

    inboundChannel.subscribe();
    inboundChannelRef.current = inboundChannel;

    return () => {
      supabase.removeChannel(inboundChannel);
      inboundChannelRef.current = null;
    };
  }, [clearCall, currentUserId, sendSignal]);

  useEffect(() => {
    return () => {
      clearCall();

      if (inboundChannelRef.current) {
        supabase.removeChannel(inboundChannelRef.current);
      }

      outboundChannelsRef.current.forEach((entry) => {
        if (entry?.channel) {
          supabase.removeChannel(entry.channel);
        }
      });
      outboundChannelsRef.current.clear();
    };
  }, [clearCall]);

  return useMemo(
    () => ({
      callSession,
      localStream,
      remoteStream,
      isMuted,
      isCameraEnabled,
      startCall,
      acceptCall,
      rejectCall,
      endCall,
      dismissCall,
      toggleMute,
      toggleCamera,
      hasActiveCall: Boolean(callSession),
    }),
    [
      acceptCall,
      callSession,
      dismissCall,
      endCall,
      isCameraEnabled,
      isMuted,
      localStream,
      rejectCall,
      remoteStream,
      startCall,
      toggleCamera,
      toggleMute,
    ],
  );
}
