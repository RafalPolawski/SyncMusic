import { getToken } from './auth.js';

/**
 * API Module
 * Responsible for fetching data from the backend REST API endpoints.
 */
export const fetchSongsLibrary = async () => {
    try {
        const token = getToken();
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const response = await fetch('/api/songs', { headers });
        if (!response.ok) throw new Error("Failed to fetch songs library");
        return await response.json();
    } catch (e) {
        console.error(e);
        return null;
    }
};
