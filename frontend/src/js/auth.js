import Keycloak from 'keycloak-js';

// Setup Keycloak instance
// This assumes the user followed the README to create:
// Realm: SyncMusic
// Client ID: syncmusic-frontend
const keycloak = new Keycloak({
    url: 'http://localhost:8082',
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
            onLoad: 'check-sso',
            checkLoginIframe: false // Prevent issues with local dev ports
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
