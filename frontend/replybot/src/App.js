import React, { useState, useEffect, useRef } from "react";
// Define API_BASE_URL here (same as in api.js)
//const API_BASE_URL = "https://replybot-kscs.onrender.com";
const API_BASE_URL = "https://facebookreplybot.onrender.com"
//const API_BASE_URL = "http://127.0.0.1:8000";

function App() {
    const [pageId, setPageId] = useState("");
    const [accessToken, setAccessToken] = useState("");
    // Replace datetime with time-only fields
    const [startTime, setStartTime] = useState("09:00"); // Default 9:00 AM
    const [durationSeconds, setDurationSeconds] = useState(1800); // Default 30 minutes
    const [activeJobs, setActiveJobs] = useState([]);
    
    const [status, setStatus] = useState("");
    const [googleSheetId, setGoogleSheetId] = useState("");
    const [sheetLink, setSheetLink] = useState("");
    const [sheetName, setSheetName] = useState("Sheet1");
    const [googleCredentials, setGoogleCredentials] = useState("");
    const [credentialsError, setCredentialsError] = useState("");
    const [presetJson, setPresetJson] = useState("");
    const [presetStatus, setPresetStatus] = useState("");
    const [additionalInstructions, setAdditionalInstructions] = useState("");
    const [instructionsStatus, setInstructionsStatus] = useState("");

    // Heartbeat state
    const [connectionStatus, setConnectionStatus] = useState("disconnected");
    const [lastHeartbeat, setLastHeartbeat] = useState(null);
    const [heartbeatLatency, setHeartbeatLatency] = useState(null);
    const [missedHeartbeats, setMissedHeartbeats] = useState(0);
    
    // Blacklist state
    const [blacklistedUsers, setBlacklistedUsers] = useState([]);
    const [blacklistUserName, setBlacklistUserName] = useState("");
    const [blacklistUserId, setBlacklistUserId] = useState("");
    const [blacklistStatus, setBlacklistStatus] = useState("");

    // Refs for intervals
    const heartbeatIntervalRef = useRef(null);
    const connectionCheckRef = useRef(null);

    // Initialize heartbeat functionality
    useEffect(() => {
        startHeartbeatMonitoring();
        
        // Cleanup intervals on component unmount
        return () => {
            if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
            if (connectionCheckRef.current) clearInterval(connectionCheckRef.current);
        };
    }, []);

    // Add useEffect to periodically check active jobs
    useEffect(() => {
        const interval = setInterval(fetchActiveJobs, 10000); // Check every 10 seconds
        return () => clearInterval(interval);
    }, []);

    const startHeartbeatMonitoring = () => {
        if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
        if (connectionCheckRef.current) clearInterval(connectionCheckRef.current);
        
        setConnectionStatus("connecting");
        
        // Send initial heartbeat
        sendHeartbeat();
        
        // Schedule regular heartbeats (every 15 seconds)
        heartbeatIntervalRef.current = setInterval(sendHeartbeat, 150000);
        
        // Check connection status regularly (every 5 seconds)
        connectionCheckRef.current = setInterval(() => {
            if (lastHeartbeat) {
                const now = new Date();
                const lastHeartbeatTime = new Date(lastHeartbeat);
                const secondsSinceLastHeartbeat = (now - lastHeartbeatTime) / 1000;
                
                // If more than 35 seconds have passed since last heartbeat, consider disconnected
                if (secondsSinceLastHeartbeat > 540) {
                    setConnectionStatus("disconnected");
                    setMissedHeartbeats(prev => prev + 1);
                }
            }
        }, 5000);
    };

    const sendHeartbeat = async () => {
        try {
            const startTime = new Date();
            const response = await fetch(`${API_BASE_URL}/heartbeat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ timestamp: new Date().toISOString() })
            });
            
            const endTime = new Date();
            const latency = endTime - startTime;
            setHeartbeatLatency(latency);
            
            if (response.ok) {
                const data = await response.json();
                setConnectionStatus("connected");
                setLastHeartbeat(data.server_time);
                setMissedHeartbeats(0);
            } else {
                setConnectionStatus("disconnected");
                setMissedHeartbeats(prev => prev + 1);
            }
        } catch (error) {
            console.error("Heartbeat failed:", error);
            setConnectionStatus("disconnected");
            setMissedHeartbeats(prev => prev + 1);
        }
    };

    // Function to fetch active jobs (updated endpoint)
    const fetchActiveJobs = async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/active-daily-jobs`);
            const data = await response.json();
            setActiveJobs(data.active_jobs || []);
        } catch (error) {
            console.error("Failed to fetch active jobs:", error);
        }
    };

    // Load blacklisted users when component mounts
    useEffect(() => {
        handleGetBlacklistedUsers();
    }, []);

    const handleStart = async () => {
        try {
            let parsedCredentials;
            try {
                parsedCredentials = JSON.parse(googleCredentials);
                setCredentialsError("");
            } catch (error) {
                setCredentialsError("Invalid JSON format for Google credentials");
                setStatus("Failed to start: Invalid Google credentials format");
                return;
            }

            if (!startTime) {
                setStatus("Please select a start time");
                return;
            }

            // Validate time format (HH:MM)
            const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
            if (!timeRegex.test(startTime)) {
                setStatus("Please enter time in HH:MM format (24-hour)");
                return;
            }

            const config = {
                config: { page_id: pageId, access_token: accessToken },
                start_time: startTime,
                duration_seconds: durationSeconds,
                google_sheet_id: googleSheetId,
                google_credentials: {
                    credentials: parsedCredentials,
                    sheet_name: sheetName
                }
            };
            
            const response = await fetch(`${API_BASE_URL}/start-daily-reply`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(config)
            });
            
            const data = await response.json();
            
            if (response.ok) {
                setStatus(data.status + ` (Next run: ${data.next_run_dhaka})`);
                
                if (data.sheet_link) {
                    setSheetLink(data.sheet_link);
                }
                
                // Refresh active jobs
                fetchActiveJobs();
            } else {
                setStatus(data.error || "Failed to start daily reply bot");
            }
        } catch (error) {
            setStatus("Failed to start: " + (error.message || "Unknown error"));
        }
    };

    const handleStop = async (jobId = null) => {
        try {
            const url = jobId 
                ? `${API_BASE_URL}/stop-daily-reply?job_id=${jobId}`
                : `${API_BASE_URL}/stop-daily-reply`;
                
            const response = await fetch(url, { method: "POST" });
            const data = await response.json();
            setStatus(data.status);
            
            // Refresh active jobs
            fetchActiveJobs();
        } catch (error) {
            setStatus("Failed to stop.");
        }
    };

    const handleAddPreset = async () => {
        if (!presetJson.trim()) {
            setPresetStatus("Please enter JSON for preset replies.");
            return;
        }
    
        try {
            const cleanedJson = presetJson.trim();
            let parsedPresets;
            
            try {
                parsedPresets = JSON.parse(cleanedJson);
            } catch (parseError) {
                // Try adding braces if they're missing
                if (cleanedJson.includes(':') && !cleanedJson.startsWith('{')) {
                    try {
                        parsedPresets = JSON.parse(`{${cleanedJson}}`);
                    } catch (nestedError) {
                        throw parseError; // Throw the original error if this fails
                    }
                } else {
                    throw parseError;
                }
            }
    
            if (typeof parsedPresets !== 'object' || parsedPresets === null || Array.isArray(parsedPresets)) {
                setPresetStatus("Invalid format. Please provide a JSON object with key-value pairs.");
                return;
            }
    
            if (Object.keys(parsedPresets).length === 0) {
                setPresetStatus("Empty JSON object. Please provide key-value pairs.");
                return;
            }
    
            for (const key in parsedPresets) {
                if (typeof parsedPresets[key] !== 'string') {
                    setPresetStatus(`Value for key "${key}" is not a string. All values must be strings.`);
                    return;
                }
            }
    
            const response = await fetch(`${API_BASE_URL}/add-preset-reply`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(parsedPresets),
            });
    
            const data = await response.json();
            
            if (response.ok) {
                // Safely handle the response data
                const addedCount = data.added?.length || 0;
                const updatedCount = data.updated?.length || 0;
                
                let successMessage = "Preset replies processed successfully!";
                
                if (addedCount > 0 || updatedCount > 0) {
                    successMessage = `Success: `;
                    if (addedCount > 0) {
                        successMessage += `Added ${addedCount} new presets. `;
                    }
                    if (updatedCount > 0) {
                        successMessage += `Updated ${updatedCount} existing presets.`;
                    }
                }
                
                setPresetStatus(successMessage.trim());
                setPresetJson("");
            } else {
                setPresetStatus(data.detail || "Failed to process preset replies.");
            }
        } catch (error) {
            if (error instanceof SyntaxError) {
                setPresetStatus(`Invalid JSON format. Example valid format: {"greeting":"Hello"}`);
            } else {
                setPresetStatus(`Error: ${error.message}`);
            }
        }
    };

    const handleGetSheetLink = async () => {
        if (!googleSheetId) {
            setStatus("Please enter a Google Sheet ID");
            return;
        }

        try {
            const response = await fetch(`${API_BASE_URL}/get-sheet-link/${googleSheetId}`);
            if (response.ok) {
                const data = await response.json();
                setSheetLink(data.sheet_link);
            } else {
                setStatus("Failed to get Google Sheet link.");
            }
        } catch (error) {
            setStatus("Error getting Google Sheet link.");
        }
    };

    const handleCredentialsUpload = (event) => {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                setGoogleCredentials(e.target.result);
                setCredentialsError("");
            };
            reader.readAsText(file);
        }
    };

    const handleSetAdditionalInstructions = async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/set-additional-instructions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    additional_instructions: additionalInstructions
                }),
            });

            if (response.ok) {
                setInstructionsStatus("Additional instructions updated successfully!");
            } else {
                const errorData = await response.json();
                setInstructionsStatus(errorData.detail || "Failed to update instructions.");
            }
        } catch (error) {
            setInstructionsStatus("Error updating additional instructions.");
        }
    };

    const handleGetAdditionalInstructions = async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/get-additional-instructions`);
            if (response.ok) {
                const data = await response.json();
                setAdditionalInstructions(data.additional_instructions || "");
                setInstructionsStatus("Current instructions loaded");
            } else {
                setInstructionsStatus("Failed to get current instructions.");
            }
        } catch (error) {
            setInstructionsStatus("Error getting current instructions.");
        }
    };

    // Blacklist functions (unchanged)
    const handleGetBlacklistedUsers = async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/get-blacklisted-users`);
            if (response.ok) {
                const data = await response.json();
                setBlacklistedUsers(data.blacklisted_users || []);
                setBlacklistStatus("Blacklist loaded successfully");
            } else {
                setBlacklistStatus("Failed to load blacklisted users");
            }
        } catch (error) {
            setBlacklistStatus("Error loading blacklisted users");
        }
    };

    const handleAddToBlacklist = async () => {
        if (!blacklistUserName && !blacklistUserId) {
            setBlacklistStatus("Please enter either a user name or user ID");
            return;
        }

        try {
            const response = await fetch(`${API_BASE_URL}/add-blacklisted-users`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    users: [{
                        user_name: blacklistUserName || null,
                        user_id: blacklistUserId || null
                    }]
                })
            });

            if (response.ok) {
                const data = await response.json();
                setBlacklistedUsers(data.blacklisted_users || []);
                setBlacklistStatus("User added to blacklist successfully");
                setBlacklistUserName("");
                setBlacklistUserId("");
            } else {
                const error = await response.json();
                setBlacklistStatus(error.detail || "Failed to add user to blacklist");
            }
        } catch (error) {
            setBlacklistStatus("Error adding user to blacklist");
        }
    };

    const handleRemoveFromBlacklist = async (userName, userId) => {
        try {
            const response = await fetch(`${API_BASE_URL}/remove-blacklisted-users`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    users: [{
                        user_name: userName || null,
                        user_id: userId || null
                    }]
                })
            });

            if (response.ok) {
                const data = await response.json();
                setBlacklistedUsers(data.blacklisted_users || []);
                setBlacklistStatus("User removed from blacklist successfully");
            } else {
                const error = await response.json();
                setBlacklistStatus(error.detail || "Failed to remove user from blacklist");
            }
        } catch (error) {
            setBlacklistStatus("Error removing user from blacklist");
        }
    };

    const handleClearBlacklist = async () => {
        if (!window.confirm("Are you sure you want to clear the entire blacklist?")) {
            return;
        }
        
        try {
            const response = await fetch(`${API_BASE_URL}/clear-blacklist`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ clear_all: true })
            });

            if (response.ok) {
                setBlacklistedUsers([]);
                setBlacklistStatus("Blacklist cleared successfully");
            } else {
                const error = await response.json();
                setBlacklistStatus(error.detail || "Failed to clear blacklist");
            }
        } catch (error) {
            setBlacklistStatus("Error clearing blacklist");
        }
    };

    // Function to get appropriate color for connection status
    const getConnectionStatusColor = () => {
        switch (connectionStatus) {
            case "connected": return "green";
            case "connecting": return "orange";
            case "disconnected": return "red";
            default: return "gray";
        }
    };

    // Helper function to format duration for display
    const formatDuration = (seconds) => {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = seconds % 60;
        
        if (hours > 0) {
            return `${hours}h ${minutes}m ${remainingSeconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${remainingSeconds}s`;
        } else {
            return `${remainingSeconds}s`;
        }
    };

    // Helper function to convert 24-hour time to 12-hour format
    const formatTime12Hour = (time24) => {
        const [hours, minutes] = time24.split(':');
        const hour12 = parseInt(hours) % 12 || 12;
        const ampm = parseInt(hours) >= 12 ? 'PM' : 'AM';
        return `${hour12}:${minutes} ${ampm}`;
    };

    // Helper function to get current time in Dhaka for display
    const getCurrentDhakaTime = () => {
        // This is an approximation - actual Dhaka time would need server calculation
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const dhaka = new Date(utc + (6 * 3600000)); // UTC+6
        return dhaka.toLocaleString();
    };

    // Connection Status Indicator component
    const ConnectionStatusIndicator = () => {
        const color = getConnectionStatusColor();
        return (
            <div style={{ 
                display: "flex", 
                alignItems: "center", 
                marginTop: "10px",
                padding: "8px",
                backgroundColor: "#f5f5f5",
                borderRadius: "5px"
            }}>
                <div style={{ 
                    width: "12px", 
                    height: "12px", 
                    borderRadius: "50%", 
                    backgroundColor: color,
                    marginRight: "8px"
                }}></div>
                <span style={{ fontWeight: "bold" }}>
                    Server Status: {connectionStatus.charAt(0).toUpperCase() + connectionStatus.slice(1)}
                </span>
                {lastHeartbeat && (
                    <span style={{ marginLeft: "15px", fontSize: "14px", color: "#555" }}>
                        Last heartbeat: {new Date(lastHeartbeat).toLocaleTimeString()} 
                        {heartbeatLatency !== null && ` (${heartbeatLatency}ms)`}
                    </span>
                )}
                {missedHeartbeats > 0 && (
                    <span style={{ 
                        marginLeft: "15px", 
                        fontSize: "14px", 
                        color: "red", 
                        fontWeight: "bold" 
                    }}>
                        Missed heartbeats: {missedHeartbeats}
                    </span>
                )}
            </div>
        );
    };

    // Detailed Connection Status Panel
    const ConnectionDetailsPanel = () => {
        if (connectionStatus === "disconnected" && missedHeartbeats > 2) {
            return (
                <div style={{
                    marginTop: "15px",
                    padding: "10px 15px",
                    backgroundColor: "#fff9f9",
                    border: "1px solid #ffcccc",
                    borderRadius: "5px"
                }}>
                    <h4 style={{ color: "red", margin: "0 0 10px 0" }}>Connection Issues Detected</h4>
                    <p style={{ margin: "0 0 5px 0" }}>
                        The server appears to be unresponsive. This might be due to:
                    </p>
                    <ul style={{ margin: "0 0 10px 0" }}>
                        <li>Server is down or restarting</li>
                        <li>Network connectivity issues</li>
                        <li>High server load</li>
                    </ul>
                    <button 
                        onClick={sendHeartbeat} 
                        style={{
                            padding: "5px 10px",
                            backgroundColor: "#f0f0f0",
                            border: "1px solid #ccc",
                            borderRadius: "3px",
                            cursor: "pointer"
                        }}
                    >
                        Check Connection Now
                    </button>
                </div>
            );
        }
        return null;
    };

    return (
        <div style={{ padding: "20px", maxWidth: "800px", margin: "0 auto" }}>
            <div style={{ 
                display: "flex", 
                justifyContent: "space-between", 
                alignItems: "center",
                borderBottom: "1px solid #eee",
                paddingBottom: "10px",
                marginBottom: "20px"
            }}>
                <h1 style={{ margin: 0 }}>Facebook Comment Reply Bot</h1>
                <button 
                    onClick={sendHeartbeat} 
                    style={{
                        padding: "5px 10px",
                        backgroundColor: "#f0f0f0",
                        border: "1px solid #ccc",
                        borderRadius: "3px",
                        cursor: "pointer"
                    }}
                >
                    Ping Server
                </button>
            </div>

            <ConnectionStatusIndicator />
            <ConnectionDetailsPanel />

            <div style={{ marginTop: "20px" }}>
                <h2>Configuration</h2>
                <div style={{ marginBottom: "15px" }}>
                    <label style={{ display: "block", marginBottom: "5px" }}>Page ID: </label>
                    <input 
                        type="text" 
                        value={pageId} 
                        onChange={(e) => setPageId(e.target.value)} 
                        style={{ width: "100%", padding: "8px", boxSizing: "border-box" }}
                    />
                </div>

                <div style={{ marginBottom: "15px" }}>
                    <label style={{ display: "block", marginBottom: "5px" }}>Page Access Token: </label>
                    <input 
                        type="text" 
                        value={accessToken} 
                        onChange={(e) => setAccessToken(e.target.value)} 
                        style={{ width: "100%", padding: "8px", boxSizing: "border-box" }}
                    />
                </div>

                <div style={{ marginBottom: "15px" }}>
                    <label style={{ display: "block", marginBottom: "5px" }}>Google Sheet ID: </label>
                    <input 
                        type="text" 
                        value={googleSheetId} 
                        onChange={(e) => setGoogleSheetId(e.target.value)} 
                        placeholder="Google Sheet ID from your sheet URL"
                        style={{ width: "100%", padding: "8px", boxSizing: "border-box" }}
                    />
                    <p style={{ fontSize: "12px", color: "#666", margin: "5px 0 0 0" }}>
                        Find your Sheet ID in the URL: https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID_HERE/edit
                    </p>
                </div>

                <div style={{ marginBottom: "15px" }}>
                    <label style={{ display: "block", marginBottom: "5px" }}>Sheet Name: </label>
                    <input 
                        type="text" 
                        value={sheetName} 
                        onChange={(e) => setSheetName(e.target.value)} 
                        placeholder="Sheet name (default: Sheet1)"
                        style={{ width: "100%", padding: "8px", boxSizing: "border-box" }}
                    />
                </div>

                <div style={{ marginTop: "10px", marginBottom: "15px" }}>
                    <label style={{ display: "block", marginBottom: "5px" }}>Google Credentials JSON: </label>
                    <textarea 
                        rows="6" 
                        value={googleCredentials} 
                        onChange={(e) => setGoogleCredentials(e.target.value)} 
                        placeholder="Paste your Google service account credentials JSON here"
                        style={{ 
                            width: "100%", 
                            padding: "8px", 
                            boxSizing: "border-box", 
                            fontFamily: "monospace" 
                        }}
                    />
                    <p style={{ fontSize: "12px", color: "#666", margin: "5px 0 0 0" }}>
                        Or upload credentials file: 
                        <input type="file" accept=".json" onChange={handleCredentialsUpload} />
                    </p>
                    {credentialsError && <p style={{ color: "red", margin: "5px 0 0 0" }}>{credentialsError}</p>}
                </div>

                {/* Updated Time Input - Time Only */}
                <div style={{ marginBottom: "15px" }}>
                    <label style={{ display: "block", marginBottom: "5px" }}>Daily Start Time (Dhaka Time): </label>
                    <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                        <input 
                            type="time" 
                            value={startTime} 
                            onChange={(e) => setStartTime(e.target.value)} 
                            style={{ padding: "8px", fontSize: "16px", minWidth: "120px" }}
                        />
                        <span style={{ fontSize: "14px", color: "#666" }}>
                            ({formatTime12Hour(startTime)})
                        </span>
                    </div>
                    <div style={{ display: "flex", gap: "10px", marginTop: "5px" }}>
                        <button 
                            onClick={() => setStartTime("09:00")}
                            style={{
                                padding: "5px 10px",
                                backgroundColor: "#f0f0f0",
                                border: "1px solid #ccc",
                                borderRadius: "3px",
                                cursor: "pointer",
                                fontSize: "12px"
                            }}
                        >
                            9:00 AM
                        </button>
                        <button 
                            onClick={() => setStartTime("12:00")}
                            style={{
                                padding: "5px 10px",
                                backgroundColor: "#f0f0f0",
                                border: "1px solid #ccc",
                                borderRadius: "3px",
                                cursor: "pointer",
                                fontSize: "12px"
                            }}
                        >
                            12:00 PM
                        </button>
                        <button 
                            onClick={() => setStartTime("15:00")}
                            style={{
                                padding: "5px 10px",
                                backgroundColor: "#f0f0f0",
                                border: "1px solid #ccc",
                                borderRadius: "3px",
                                cursor: "pointer",
                                fontSize: "12px"
                            }}
                        >
                            3:00 PM
                        </button>
                        <button 
                            onClick={() => setStartTime("18:00")}
                            style={{
                                padding: "5px 10px",
                                backgroundColor: "#f0f0f0",
                                border: "1px solid #ccc",
                                borderRadius: "3px",
                                cursor: "pointer",
                                fontSize: "12px"
                            }}
                        >
                            6:00 PM
                        </button>
                    </div>
                    <p style={{ fontSize: "12px", color: "#666", margin: "5px 0 0 0" }}>
                        Bot will run every day at this time in Dhaka timezone (UTC+6)
                    </p>
                </div>

                <div style={{ marginBottom: "15px" }}>
                    <label style={{ display: "block", marginBottom: "5px" }}>Daily Duration: </label>
                    <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                        <input 
                            type="number" 
                            value={durationSeconds} 
                            onChange={(e) => setDurationSeconds(Number(e.target.value))} 
                            min="60"
                            max="86400"
                            style={{ flex: 1, padding: "8px", boxSizing: "border-box" }}
                        />
                        <span style={{ fontSize: "14px", color: "#666", minWidth: "100px" }}>
                            ({formatDuration(durationSeconds)})
                        </span>
                    </div>
                    <div style={{ display: "flex", gap: "10px", marginTop: "5px" }}>
                        <button 
                            onClick={() => setDurationSeconds(1800)}
                            style={{
                                padding: "5px 10px",
                                backgroundColor: "#f0f0f0",
                                border: "1px solid #ccc",
                                borderRadius: "3px",
                                cursor: "pointer",
                                fontSize: "12px"
                            }}
                        >
                            30 min
                        </button>
                        <button 
                            onClick={() => setDurationSeconds(3600)}
                            style={{
                                padding: "5px 10px",
                                backgroundColor: "#f0f0f0",
                                border: "1px solid #ccc",
                                borderRadius: "3px",
                                cursor: "pointer",
                                fontSize: "12px"
                            }}
                        >
                            1 hour
                        </button>
                        <button 
                            onClick={() => setDurationSeconds(7200)}
                            style={{
                                padding: "5px 10px",
                                backgroundColor: "#f0f0f0",
                                border: "1px solid #ccc",
                                borderRadius: "3px",
                                cursor: "pointer",
                                fontSize: "12px"
                            }}
                        >
                            2 hours
                        </button>
                        <button 
                            onClick={() => setDurationSeconds(21600)}
                            style={{
                                padding: "5px 10px",
                                backgroundColor: "#f0f0f0",
                                border: "1px solid #ccc",
                                borderRadius: "3px",
                                cursor: "pointer",
                                fontSize: "12px"
                            }}
                        >
                            6 hours
                        </button>
                    </div>
                    <p style={{ fontSize: "12px", color: "#666", margin: "5px 0 0 0" }}>
                        How long to run each day (in seconds)
                    </p>
                </div>

                <div style={{ marginTop: "20px", display: "flex", gap: "10px" }}>
                    <button 
                        onClick={handleStart}
                        style={{
                            padding: "10px 15px",
                            backgroundColor: "#4CAF50",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer"
                        }}
                    >
                        Start Daily Reply Bot
                    </button>
                    <button 
                        onClick={() => handleStop()}
                        style={{
                            padding: "10px 15px",
                            backgroundColor: "#f44336",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer"
                        }}
                    >
                        Stop All Jobs
                    </button>
                    <button 
                        onClick={handleGetSheetLink}
                        style={{
                            padding: "10px 15px",
                            backgroundColor: "#2196F3",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer"
                        }}
                    >
                        Get Sheet Link
                    </button>
                </div>
            </div>

            {/* Active Jobs Display - Updated for daily jobs */}
            {activeJobs.length > 0 && (
                <div style={{ 
                    marginTop: "20px", 
                    padding: "10px 15px", 
                    backgroundColor: "#e8f5e8", 
                    borderRadius: "4px", 
                    border: "1px solid #4CAF50" 
                }}>
                    <h3 style={{ margin: "0 0 10px 0" }}>Active Daily Jobs ({activeJobs.length})</h3>
                    {activeJobs.map(job => (
                        <div key={job.job_id} style={{ 
                            display: "flex", 
                            justifyContent: "space-between", 
                            alignItems: "center",
                            marginBottom: "8px",
                            padding: "8px",
                            backgroundColor: "rgba(255,255,255,0.5)",
                            borderRadius: "3px"
                        }}>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontFamily: "monospace", fontSize: "14px", fontWeight: "bold" }}>
                                    {job.job_id}
                                </div>
                                <div style={{ fontSize: "12px", color: "#666" }}>
                                    Daily at {formatTime12Hour(job.start_time)} • {formatDuration(job.duration_seconds)}
                                </div>
                                <div style={{ fontSize: "12px", color: "#666" }}>
                                    Next run: {new Date(job.next_run_dhaka).toLocaleString()}
                                </div>
                            </div>
                            <button 
                                onClick={() => handleStop(job.job_id)}
                                style={{
                                    padding: "5px 10px",
                                    backgroundColor: "#f44336",
                                    color: "white",
                                    border: "none",
                                    borderRadius: "3px",
                                    cursor: "pointer",
                                    fontSize: "12px"
                                }}
                            >
                                Stop
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {status && (
                <div style={{ 
                    marginTop: "20px", 
                    padding: "10px 15px", 
                    backgroundColor: "#f8f9fa", 
                    borderRadius: "4px", 
                    border: "1px solid #dee2e6" 
                }}>
                    <h3 style={{ margin: "0 0 5px 0" }}>Status:</h3>
                    <p style={{ margin: 0 }}>{status}</p>
                </div>
            )}

            <div style={{ marginTop: "30px" }}>
                <h2>Add Preset Replies (JSON Format)</h2>
                <textarea
                    rows="6"
                    value={presetJson}
                    onChange={(e) => setPresetJson(e.target.value)}
                    placeholder={'{\n  "greeting": "Hello!",\n  "farewell": "Goodbye!"\n}'}
                    style={{ 
                        width: "100%", 
                        fontFamily: 'monospace',
                        marginBottom: "10px",
                        padding: "10px",
                        boxSizing: "border-box"
                    }}
                />
                <button 
                    onClick={handleAddPreset}
                    style={{
                        padding: "10px 15px",
                        backgroundColor: "#2196F3",
                        color: "white",
                        border: "none",
                        borderRadius: "4px",
                        cursor: "pointer"
                    }}
                >
                    Add Preset Replies
                </button>
                {presetStatus && (
                    <p style={{ 
                        color: presetStatus.includes("Success") ? "green" : "red",
                        margin: "10px 0 0 0" 
                    }}>
                        {presetStatus}
                    </p>
                )}
            </div>

            <div style={{ marginTop: "30px", borderTop: "1px solid #ccc", paddingTop: "20px" }}>
                <h2>Additional Instructions Configuration</h2>
                <p style={{ margin: "0 0 10px 0" }}>These instructions will be appended to the AI prompt</p>
                <textarea
                    rows="6"
                    value={additionalInstructions}
                    onChange={(e) => setAdditionalInstructions(e.target.value)}
                    placeholder="Enter additional instructions for the AI..."
                    style={{ 
                        width: "100%", 
                        marginBottom: "10px",
                        padding: "10px",
                        boxSizing: "border-box"
                    }}
                />
                <div style={{ display: "flex", gap: "10px" }}>
                    <button 
                        onClick={handleSetAdditionalInstructions}
                        style={{
                            padding: "10px 15px",
                            backgroundColor: "#2196F3",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer"
                        }}
                    >
                        Save Instructions
                    </button>
                    <button 
                        onClick={handleGetAdditionalInstructions}
                        style={{
                            padding: "10px 15px",
                            backgroundColor: "#f0f0f0",
                            border: "1px solid #ccc",
                            borderRadius: "4px",
                            cursor: "pointer"
                        }}
                    >
                        Load Current Instructions
                    </button>
                </div>
                {instructionsStatus && (
                    <p style={{ 
                        color: instructionsStatus.includes("success") || instructionsStatus.includes("loaded") ? "green" : "red",
                        margin: "10px 0 0 0"
                    }}>
                        {instructionsStatus}
                    </p>
                )}
            </div>

            {sheetLink && (
                <div style={{ marginTop: "20px" }}>
                    <h3>Google Sheet:</h3>
                    <a 
                        href={sheetLink} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        style={{
                            color: "#2196F3",
                            textDecoration: "none"
                        }}
                    >
                        Open Google Sheet ({sheetName})
                    </a>
                </div>
            )}

            {/* Blacklist Management (unchanged) */}
            <div style={{ marginTop: "30px", borderTop: "1px solid #ccc", paddingTop: "20px" }}>
                <h2>Blacklist Management</h2>
                <p>Users on the blacklist will not receive automated replies</p>
                
                <div style={{ display: "flex", gap: "10px", marginBottom: "15px" }}>
                    <input
                        type="text"
                        value={blacklistUserName}
                        onChange={(e) => setBlacklistUserName(e.target.value)}
                        placeholder="User Name"
                        style={{ flex: 1, padding: "8px" }}
                    />
                    <input
                        type="text"
                        value={blacklistUserId}
                        onChange={(e) => setBlacklistUserId(e.target.value)}
                        placeholder="User ID"
                        style={{ flex: 1, padding: "8px" }}
                    />
                    <button
                        onClick={handleAddToBlacklist}
                        style={{
                            padding: "8px 15px",
                            backgroundColor: "#2196F3",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer"
                        }}
                    >
                        Add to Blacklist
                    </button>
                </div>
                
                {blacklistStatus && (
                    <p style={{ 
                        color: blacklistStatus.includes("success") ? "green" : "red",
                        margin: "10px 0"
                    }}>
                        {blacklistStatus}
                    </p>
                )}
                
                <div style={{ marginTop: "15px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                        <h3 style={{ margin: 0 }}>Blacklisted Users ({blacklistedUsers.length})</h3>
                        <button
                            onClick={handleClearBlacklist}
                            style={{
                                padding: "5px 10px",
                                backgroundColor: "#f44336",
                                color: "white",
                                border: "none",
                                borderRadius: "4px",
                                cursor: "pointer",
                                fontSize: "12px"
                            }}
                        >
                            Clear All
                        </button>
                    </div>
                    
                    <div style={{ maxHeight: "200px", overflow: "auto", border: "1px solid #ddd", borderRadius: "4px" }}>
                        {blacklistedUsers.length > 0 ? (
                            <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                <thead style={{ position: "sticky", top: 0, backgroundColor: "#f5f5f5" }}>
                                    <tr>
                                        <th style={{ padding: "8px", textAlign: "left", borderBottom: "1px solid #ddd" }}>User Name</th>
                                        <th style={{ padding: "8px", textAlign: "left", borderBottom: "1px solid #ddd" }}>User ID</th>
                                        <th style={{ padding: "8px", textAlign: "right", borderBottom: "1px solid #ddd" }}>Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {blacklistedUsers.map((user, index) => (
                                        <tr key={index} style={{ backgroundColor: index % 2 === 0 ? "#fff" : "#f9f9f9" }}>
                                            <td style={{ padding: "8px", borderBottom: "1px solid #eee" }}>{user.user_name || "-"}</td>
                                            <td style={{ padding: "8px", borderBottom: "1px solid #eee" }}>{user.user_id || "-"}</td>
                                            <td style={{ padding: "8px", textAlign: "right", borderBottom: "1px solid #eee" }}>
                                                <button
                                                    onClick={() => handleRemoveFromBlacklist(user.user_name, user.user_id)}
                                                    style={{
                                                        padding: "3px 8px",
                                                        backgroundColor: "#f44336",
                                                        color: "white",
                                                        border: "none",
                                                        borderRadius: "3px",
                                                        cursor: "pointer",
                                                        fontSize: "12px"
                                                    }}
                                                >
                                                    Remove
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ) : (
                            <p style={{ padding: "15px", textAlign: "center", color: "#666" }}>No users in blacklist</p>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default App;