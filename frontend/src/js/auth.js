import Keycloak from 'keycloak-js';

// Setup Keycloak instance
// Proxy-based URL: uses the same host/port as the frontend (Caddy handles the routing to /auth)
const kcUrl = window.location.origin + '/auth';

const keycloak = new Keycloak({
    url: kcUrl,
    realm: 'syncmusic',
    clientId: 'syncmusic-frontend'
});

let initPromise = null;

/**
 * Initializes Keycloak and returns the authenticated status.
 * Fails gracefully if offline or Keycloak is unreachable.
 */
export const initAuth = async () => {
    if (initPromise) return initPromise;

    initPromise = (async () => {
        const timeout = new Promise(resolve => 
            setTimeout(() => resolve({ authenticated: false, keycloak: null, error: 'TIMEOUT' }), 3000)
        );

        try {
            const initTask = (async () => {
                const authenticated = await keycloak.init({
                    onLoad: 'check-sso',
                    pkceMethod: 'S256',
                    silentCheckSsoRedirectUri: window.location.origin + '/silent-check-sso.html',
                    checkLoginIframe: false,
                    enableLogging: true
                });

                if (authenticated) {
                    // Start periodic token refresh
                    setInterval(() => {
                        keycloak.updateToken(70).then((refreshed) => {
                            if (refreshed) console.debug('[Auth] Token refreshed');
                        }).catch(() => {
                            console.warn('[Auth] Failed to refresh token');
                        });
                    }, 60000); // Check every minute
                }

                return { authenticated, keycloak };
            })();

            return await Promise.race([initTask, timeout]);
        } catch (error) {
            console.warn("[Auth] Keycloak unreachable or failed to initialize. Falling back to anonymous mode.", error);
            return { authenticated: false, keycloak: null, error };
        }
    })();

    return initPromise;
};

export const login = () => keycloak.login();
export const logout = () => keycloak.logout();
export const getToken = () => keycloak.token;
export const getProfile = () => keycloak.tokenParsed;

export default keycloak;
