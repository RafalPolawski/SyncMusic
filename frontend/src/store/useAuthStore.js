import { create } from 'zustand';
import Keycloak from 'keycloak-js';

const kcUrl = window.location.origin;
export const keycloak = new Keycloak({
    url: kcUrl,
    realm: 'syncmusic',
    clientId: 'syncmusic-frontend'
});

export const useAuthStore = create((set, get) => ({
    isAuthenticated: false,
    isChecking: true,
    isGuestMode: false,
    userProfile: null,
    error: null,

    checkAuth: async () => {
        const timeout = new Promise(resolve => 
            setTimeout(() => resolve({ authenticated: false }), 3000)
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
                    setInterval(() => {
                        keycloak.updateToken(70).then((refreshed) => {
                            if (refreshed) console.debug('[Auth] Token refreshed');
                        }).catch(() => {
                            console.warn('[Auth] Failed to refresh token');
                        });
                    }, 60000); // 1-minute interval
                }

                return { authenticated };
            })();

            const result = await Promise.race([initTask, timeout]);
            
            set({ 
                isAuthenticated: result.authenticated, 
                isChecking: false,
                isGuestMode: false,
                userProfile: result.authenticated ? keycloak.tokenParsed : null 
            });

            return result.authenticated;
        } catch (error) {
            console.warn("[Auth] Keycloak unreachable or failed to init", error);
            set({ isAuthenticated: false, isChecking: false, error });
            return false;
        }
    },

    login: () => keycloak.login(),
    logout: () => keycloak.logout(),
    getToken: () => keycloak.token,
    
    // For anonymous mode
    setGuestMode: (nickname) => {
        localStorage.setItem("syncMusicNick", nickname);
        set({ isAuthenticated: false, isChecking: false, isGuestMode: true, userProfile: { preferred_username: nickname } });
    }
}));

