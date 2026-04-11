import { create } from 'zustand';

export const useQueueStore = create((set, get) => ({
    queue: [],
    
    // Add song to end of queue
    enqueue: (song) => set(state => ({ queue: [...state.queue, song] })),
    
    // Remove specific song
    dequeue: (index) => set(state => ({ queue: state.queue.filter((_, i) => i !== index) })),
    
    // Move to next song and shift queue
    nextTrack: () => {
        const q = get().queue;
        if (q.length === 0) return null;
        const next = q[0];
        set({ queue: q.slice(1) });
        return next;
    },

    // Completely replace queue
    setQueue: (newQueue) => set({ queue: newQueue }),
    
    clearQueue: () => set({ queue: [] })
}));
