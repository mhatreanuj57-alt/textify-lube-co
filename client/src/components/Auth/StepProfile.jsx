import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { Camera, Check, CircleX, LoaderCircle } from 'lucide-react';
import useUsername from '@/hooks/useUsername';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { sanitizeFileName } from '@/lib/chat';
import styles from './StepProfile.module.css';

export default function StepProfile({ loading, error, onComplete, setError, setLoading }) {
  const { user } = useAuth();
  const formRef = useRef(null);
  const fileInputRef = useRef(null);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [about, setAbout] = useState('Hey there! I am using Textify.');
  const [avatarFile, setAvatarFile] = useState(null);
  const [avatarPreview, setAvatarPreview] = useState('');
  const { available, checking, error: usernameError, valid } = useUsername(username, user?.id);

  useEffect(() => {
    return () => {
      if (avatarPreview) {
        URL.revokeObjectURL(avatarPreview);
      }
    };
  }, [avatarPreview]);

  useLayoutEffect(() => {
    if (!formRef.current) {
      return undefined;
    }

    const ctx = gsap.context(() => {
      gsap.from('[data-profile-field]', {
        y: 18,
        opacity: 0,
        duration: 0.3,
        stagger: 0.06,
        ease: 'power2.out',
      });
    }, formRef);

    return () => ctx.revert();
  }, []);

  const usernameState = useMemo(() => {
    if (!username.trim()) {
      return null;
    }
    if (checking) {
      return 'checking';
    }
    if (!valid || usernameError) {
      return 'invalid';
    }
    return available ? 'available' : 'taken';
  }, [available, checking, username, usernameError, valid]);

  const handleAvatarChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (avatarPreview) {
      URL.revokeObjectURL(avatarPreview);
    }

    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!user?.id) {
      setError('Your session expired. Please sign in again.');
      return;
    }

    if (!displayName.trim()) {
      setError('Display name is required.');
      return;
    }

    if (!username.trim() || !valid || !available) {
      setError('Choose an available username before continuing.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      let avatarUrl = '';

      if (avatarFile) {
        const avatarPath = `${user.id}/${Date.now()}-${sanitizeFileName(avatarFile.name)}`;
        const { error: uploadError } = await supabase.storage.from('avatars').upload(avatarPath, avatarFile, {
          upsert: true,
        });

        if (uploadError) {
          throw uploadError;
        }

        const {
          data: { publicUrl },
        } = supabase.storage.from('avatars').getPublicUrl(avatarPath);
        avatarUrl = publicUrl;
      }

      const payload = {
        id: user.id,
        display_name: displayName.trim(),
        username: username.trim(),
        about: about.trim(),
        avatar_url: avatarUrl,
        is_online: true,
        last_seen: new Date().toISOString(),
      };

      const { error: upsertError } = await supabase.from('profiles').upsert({
        ...payload,
        user_id: user.id,
      });

      if (upsertError) {
        // If user_id column is missing, retry without it
        if (upsertError.code === '42703' || upsertError.message?.includes('user_id')) {
          const { error: retryError } = await supabase.from('profiles').upsert(payload);
          if (retryError) {
            throw retryError;
          }
        } else {
          throw upsertError;
        }
      }

      await onComplete();
    } catch (submitError) {
      setError(submitError.message || 'Unable to save your profile.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className={styles.card}>
      <div className={styles.header}>
        <span className={styles.kicker}>Almost there</span>
        <h1>Set up your Textify profile</h1>
        <p>Pick how people will recognize you in chats.</p>
      </div>

      <form ref={formRef} className={styles.form} onSubmit={handleSubmit}>
        <div data-profile-field className={styles.avatarBlock}>
          <button
            className={styles.avatarButton}
            type="button"
            onClick={() => fileInputRef.current?.click()}
          >
            {avatarPreview ? (
              <img src={avatarPreview} alt="Avatar preview" className={styles.avatarImage} />
            ) : (
              <>
                <Camera size={22} />
                <span>Add photo</span>
              </>
            )}
          </button>
          <input
            ref={fileInputRef}
            className={styles.hiddenInput}
            type="file"
            accept="image/*"
            onChange={handleAvatarChange}
          />
        </div>

        <label data-profile-field className={styles.field}>
          <span>Display name</span>
          <input
            className={styles.input}
            type="text"
            placeholder="Anuj Sharma"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
          />
        </label>

        <label data-profile-field className={styles.field}>
          <span>Username</span>
          <div className={styles.usernameWrap}>
            <span className={styles.prefix}>@</span>
            <input
              className={styles.usernameInput}
              type="text"
              placeholder="anuj_texts"
              value={username}
              onChange={(event) => setUsername(event.target.value.toLowerCase())}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              required
            />
            {usernameState === 'checking' && <LoaderCircle className={styles.spin} size={18} />}
            {usernameState === 'available' && <Check size={18} className={styles.available} />}
            {(usernameState === 'invalid' || usernameState === 'taken') && (
              <CircleX size={18} className={styles.taken} />
            )}
          </div>
          <small className={styles.help}>
            {usernameError ||
              (usernameState === 'available'
                ? 'Username is available.'
                : usernameState === 'taken'
                  ? 'That username is already taken.'
                  : 'Use 3-20 lowercase letters, numbers, or underscores.')}
          </small>
        </label>

        <label data-profile-field className={styles.field}>
          <span>About</span>
          <textarea
            className={styles.textarea}
            rows={3}
            placeholder="Hey there! I am using Textify."
            value={about}
            onChange={(event) => setAbout(event.target.value)}
          />
        </label>

        {error ? <p className={styles.error}>{error}</p> : null}

        <button data-profile-field className={styles.button} type="submit" disabled={loading}>
          {loading ? 'Saving profile...' : "Let's Go"}
        </button>
      </form>
    </section>
  );
}
