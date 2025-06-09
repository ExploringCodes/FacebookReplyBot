// Define the base URL for API calls
//const API_BASE_URL = "https://replybot-kscs.onrender.com";
const API_BASE_URL = "http://127.0.0.1:8000";

/**
 * Start the comment reply scheduler
 * @param {Object} config - Configuration object containing all settings
 * @returns {Promise} - Promise that resolves to response data
 */
export const startScheduler = async (config) => {
  try {
    const response = await fetch(`${API_BASE_URL}/start-scheduler`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || "Failed to start scheduler");
    }

    return await response.json();
  } catch (error) {
    console.error("Error starting scheduler:", error);
    throw error;
  }
};

/**
 * Stop the comment reply scheduler
 * @returns {Promise} - Promise that resolves to response data
 */
export const stopScheduler = async () => {
  try {
    const response = await fetch(`${API_BASE_URL}/stop-scheduler`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || "Failed to stop scheduler");
    }

    return await response.json();
  } catch (error) {
    console.error("Error stopping scheduler:", error);
    throw error;
  }
};