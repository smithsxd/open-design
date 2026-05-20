import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchVelaLoginStatus,
  startVelaLogin,
  velaLogout,
  type VelaLoginStatus,
} from '../providers/daemon';
import { useI18n } from '../i18n';

interface AmrLoginPillProps {
  className?: string;
}

const POLL_INTERVAL_MS = 2000;
const POLL_DURATION_MS = 5 * 60 * 1000;

// AMR-specific login pill that lives as a sibling inside the installed
// agent card (next to the Test button). The pill polls
// `/api/integrations/vela/status` after a Sign-in click until the daemon
// reports loggedIn=true — vela CLI handles the device-authorization URL /
// code / browser open itself (see apps/cli/internal/commands/login.go in
// nexu-io/vela), so Open Design's UI only needs to kick the subprocess
// off and surface the result.
export function AmrLoginPill({ className }: AmrLoginPillProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<VelaLoginStatus | null>(null);
  const [pending, setPending] = useState<null | 'login' | 'logout'>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hoverLogout, setHoverLogout] = useState(false);
  const pollRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    const next = await fetchVelaLoginStatus();
    if (next) setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    void refresh();
    return () => stopPolling();
  }, [refresh, stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    const startedAt = Date.now();
    const tick = async () => {
      const next = await refresh();
      if (next?.loggedIn) {
        stopPolling();
        setPending(null);
        return;
      }
      if (Date.now() - startedAt > POLL_DURATION_MS) {
        stopPolling();
        setPending(null);
      }
    };
    pollRef.current = window.setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
  }, [refresh, stopPolling]);

  const handleLogin = useCallback(
    async (event: React.MouseEvent) => {
      event.stopPropagation();
      setErrorMessage(null);
      setPending('login');
      const result = await startVelaLogin();
      if (!result.ok && !result.alreadyRunning) {
        setPending(null);
        setErrorMessage(result.error || 'vela login failed');
        return;
      }
      startPolling();
    },
    [startPolling],
  );

  const handleLogout = useCallback(
    async (event: React.MouseEvent) => {
      event.stopPropagation();
      setErrorMessage(null);
      setPending('logout');
      const result = await velaLogout();
      setPending(null);
      if (!result.ok) {
        setErrorMessage('logout failed');
        return;
      }
      await refresh();
    },
    [refresh],
  );

  const loggedIn = status?.loggedIn === true;
  const userEmail = status?.user?.email ?? '';
  const loginInFlight = pending === 'login';
  const logoutInFlight = pending === 'logout';

  return (
    <div
      className={'amr-login-pill' + (className ? ' ' + className : '')}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {loggedIn ? (
        <button
          type="button"
          className={
            'ghost icon-btn agent-card-test-btn amr-login-pill-status' +
            (hoverLogout ? ' hover-logout' : '')
          }
          onMouseEnter={() => setHoverLogout(true)}
          onMouseLeave={() => setHoverLogout(false)}
          onFocus={() => setHoverLogout(true)}
          onBlur={() => setHoverLogout(false)}
          disabled={logoutInFlight}
          onClick={handleLogout}
          title={userEmail || undefined}
          aria-label={t('settings.amrLogout')}
        >
          {logoutInFlight
            ? t('settings.amrLoggingOut')
            : hoverLogout
              ? t('settings.amrLogout')
              : t('settings.amrLoggedInPill')}
        </button>
      ) : (
        <button
          type="button"
          className="ghost icon-btn agent-card-test-btn"
          disabled={loginInFlight}
          onClick={handleLogin}
        >
          {loginInFlight
            ? t('settings.amrLoggingIn')
            : t('settings.amrLogin')}
        </button>
      )}
      {errorMessage ? (
        <span className="amr-login-pill-error" role="alert">
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
