import { create } from 'zustand';

export const useNetworkStore = create((set, get) => ({
    rtt: 0,
    isOffline: false,
    isConnected: false,
    rooms: [],
    isLoadingRooms: true,

    setRtt: (rtt) => set({ rtt, isOffline: rtt === 'OFFLINE', isConnected: rtt !== 'OFFLINE' }),
    
    fetchRooms: async () => {
        set({ isLoadingRooms: true });
        try {
            const res = await fetch('/api/rooms');
            if (res.ok) {
                const rooms = await res.json();
                set({ rooms: rooms || [], isLoadingRooms: false });
            } else {
                set({ rooms: [], isLoadingRooms: false, isOffline: true });
            }
        } catch (e) {
            set({ rooms: [], isLoadingRooms: false, isOffline: true });
        }
    }
}));
