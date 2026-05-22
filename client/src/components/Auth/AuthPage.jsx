import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import StepLogin from '@/components/Auth/StepLogin';
import StepPhone from '@/components/Auth/StepPhone';
import StepProfile from '@/components/Auth/StepProfile';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import styles from './AuthPage.module.css';

export default function AuthFlowPage() {
  const navigate = useNavigate();
  const { user, profile, profileResolved, refreshProfile } = useAuth();
  const [step, setStep] = useState('login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user && !profileResolved) {
      return;
    }

    if (user && profile) {
      if (!profile.phone) {
        setStep('phone');
      } else if (!profile.username) {
        setStep('profile');
      } else {
        navigate('/chat', { replace: true });
      }
      return;
    }

    if (user && !profile) {
      setStep('phone');
    }
  }, [navigate, profile, profileResolved, user]);

  const handleGoogleLogin = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { error: authError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin,
        },
      });
      if (authError) throw authError;
    } catch (submitError) {
      setError(submitError.message || 'Unable to connect to Google.');
      setLoading(false);
    }
  }, []);

  const handlePhoneSubmit = useCallback(async (phone) => {
    if (!user?.id) return;
    setLoading(true);
    setError('');

    try {
      // Check if phone is already taken by another user
      const { data: existing, error: checkError } = await supabase
        .from('profiles')
        .select('id')
        .eq('phone', phone)
        .maybeSingle();

      if (checkError) throw checkError;
      
      if (existing && existing.id !== user.id) {
        throw new Error('This phone number is already registered with another account.');
      }

      // Update or Insert profile with phone
      const payload = {
        id: user.id,
        phone: phone,
      };

      const { error: upsertError } = await supabase.from('profiles').upsert(payload);

      if (upsertError) throw upsertError;

      await refreshProfile();
      setStep('profile');
    } catch (err) {
      setError(err.message || 'Unable to save phone number.');
    } finally {
      setLoading(false);
    }
  }, [refreshProfile, user]);

  const handleProfileComplete = useCallback(async () => {
    await refreshProfile();
    navigate('/chat', { replace: true });
  }, [navigate, refreshProfile]);

  return (
    <main className={styles.page}>
      <div className={styles.gridGlow} />
      <div className={styles.content}>
        {step === 'login' && (
          <StepLogin
            onGoogleLogin={handleGoogleLogin}
            loading={loading}
            error={error}
          />
        )}
        {step === 'phone' && (
          <StepPhone
            phone={profile?.phone}
            onComplete={handlePhoneSubmit}
            loading={loading}
            error={error}
          />
        )}
        {step === 'profile' && (
          <StepProfile
            loading={loading}
            error={error}
            onComplete={handleProfileComplete}
            setError={setError}
            setLoading={setLoading}
          />
        )}
      </div>
    </main>
  );
}
