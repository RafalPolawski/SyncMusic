import Keycloak from 'keycloak-js';

// Setup Keycloak instance
// Proxy-based URL: uses the same host/port as the frontend (Caddy handles the routing to /auth)
const kcUrl = window.location.origin + '/auth';

const keycloak = new Keycloak({
    url: kcUrl,
    realm: 'SyncMusic',
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
        try {
            const authenticated = await keycloak.init({
                pkceMethod: 'S256',
                enableLogging: true
            });
            return { authenticated, keycloak };
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
