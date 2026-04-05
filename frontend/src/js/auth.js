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
                    pkceMethod: 'S256',
                    checkLoginIframe: false,
                    enableLogging: true
                });
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
