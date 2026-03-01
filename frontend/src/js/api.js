/**
 * API Module
 * Responsible for fetching data from the backend REST API endpoints.
 */
export const fetchSongsLibrary = async () => {
    try {
        const response = await fetch('/api/songs');
        if (!response.ok) throw new Error("Failed to fetch songs library");
        return await response.json();
    } catch (e) {
        console.error(e);
        return null;
    }
};
