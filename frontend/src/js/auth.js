import Keycloak from 'keycloak-js';

// Setup Keycloak instance
// Dynamic Keycloak URL: allows same-origin mapping (e.g. Tailscale IP mapping)
const kcUrl = window.location.protocol + '//' + window.location.hostname + ':8082';

const keycloak = new Keycloak({
    url: kcUrl,
    realm: 'SyncMusic',
    clientId: 'syncmusic-frontend'
});

/**
 * Initializes Keycloak and returns the authenticated status.
 * Fails gracefully if offline or Keycloak is unreachable.
 */
export const initAuth = async () => {
    try {
        const authenticated = await keycloak.init({
            pkceMethod: 'S256'
        });
        return { authenticated, keycloak };
    } catch (error) {
        console.warn("[Auth] Keycloak unreachable or failed to initialize. Falling back to anonymous mode.", error);
        return { authenticated: false, keycloak: null, error };
    }
};

export const login = () => keycloak.login();
export const logout = () => keycloak.logout();
export const getToken = () => keycloak.token;
export const getProfile = () => keycloak.tokenParsed;

export default keycloak;
