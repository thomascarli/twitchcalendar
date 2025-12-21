// ===== Twitch API Configuration =====

// ⚠️ DEVELOPER: Set your Client ID here after registering at https://dev.twitch.tv/console/apps
// App name: "Twitch Calendar" (or anything you prefer)
// Once set, users just click "Login with Twitch" - no setup needed on their end!
const TWITCH_CLIENT_ID = 'uzp4l537v82gifbcljwm9dqc4uzkxn'; // <-- Paste your Client ID here

const TWITCH_API = {
    clientId: TWITCH_CLIENT_ID,
    authUrl: 'https://id.twitch.tv/oauth2/authorize',
    apiBase: 'https://api.twitch.tv/helix',
    scopes: ['user:read:follows'],
    redirectUri: window.location.origin
};

// ===== Local Storage Keys =====
const STORAGE_KEYS = {
    accessToken: 'twitchcal_access_token',
    clientId: 'twitchcal_client_id',
    followedStreamers: 'twitchcal_followed',
    tokenExpiry: 'twitchcal_token_expiry'
};

// ===== Color Palette for Streamers =====
const STREAMER_COLORS = ['purple', 'green', 'red', 'blue', 'yellow', 'pink', 'orange', 'teal'];

function getStreamerColor(id) {
    // Generate consistent color based on streamer ID
    const hash = typeof id === 'string' ? id.split('').reduce((a, b) => a + b.charCodeAt(0), 0) : id;
    return STREAMER_COLORS[hash % STREAMER_COLORS.length];
}

// ===== State =====

const state = {
    currentView: 'week',
    currentDate: new Date(),
    followedStreamers: new Map(), // Map of id -> streamer data
    liveStreamers: new Map(), // Map of id -> live stream data
    events: [],
    searchResults: [],
    isSearching: false,
    isConnected: false,
    accessToken: null,
    clientId: null,
    liveCheckInterval: null
};

// ===== DOM Elements =====

const elements = {
    calendar: document.getElementById('calendar'),
    currentDate: document.getElementById('current-date'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),
    todayBtn: document.getElementById('today-btn'),
    viewBtns: document.querySelectorAll('.view-btn'),
    streamersList: document.getElementById('streamers-list'),
    followingCount: document.getElementById('following-count'),
    searchInput: document.getElementById('streamer-search'),
    searchResults: document.getElementById('search-results'),
    searchLoading: document.getElementById('search-loading'),
    modalOverlay: document.getElementById('modal-overlay'),
    modalContent: document.getElementById('modal-content'),
    modalClose: document.getElementById('modal-close'),
    connectBtn: document.getElementById('connect-btn'),
    connectBtnText: document.getElementById('connect-btn-text'),
    connectModalOverlay: document.getElementById('connect-modal-overlay'),
    connectModalClose: document.getElementById('connect-modal-close'),
    clientIdInput: document.getElementById('client-id'),
    authorizeBtn: document.getElementById('authorize-btn'),
    connectStatus: document.getElementById('connect-status'),
    redirectUrl: document.getElementById('redirect-url'),
    // Mobile elements
    mobileTabs: document.querySelectorAll('.mobile-tab'),
    streamersPanel: document.getElementById('streamers-panel'),
    calendarPanel: document.getElementById('calendar-panel')
};

// ===== Twitch API Functions =====

async function searchChannels(query) {
    if (!state.isConnected || !query.trim()) {
        return [];
    }

    try {
        const response = await fetch(
            `${TWITCH_API.apiBase}/search/channels?query=${encodeURIComponent(query)}&first=20`,
            {
                headers: {
                    'Authorization': `Bearer ${state.accessToken}`,
                    'Client-Id': state.clientId
                }
            }
        );

        if (!response.ok) {
            if (response.status === 401) {
                handleAuthError();
            }
            throw new Error('Search failed');
        }

        const data = await response.json();
        return data.data.map(channel => ({
            id: channel.id,
            name: channel.display_name,
            login: channel.broadcaster_login,
            category: channel.game_name || 'Variety',
            profileImage: channel.thumbnail_url,
            isLive: channel.is_live,
            color: getStreamerColor(channel.id)
        }));
    } catch (error) {
        console.error('Search error:', error);
        return [];
    }
}

async function getChannelSchedule(broadcasterId) {
    if (!state.isConnected) return null;

    try {
        const response = await fetch(
            `${TWITCH_API.apiBase}/schedule?broadcaster_id=${broadcasterId}&first=25`,
            {
                headers: {
                    'Authorization': `Bearer ${state.accessToken}`,
                    'Client-Id': state.clientId
                }
            }
        );

        if (!response.ok) {
            if (response.status === 404) {
                // No schedule set
                return null;
            }
            throw new Error('Failed to fetch schedule');
        }

        const data = await response.json();
        return data.data;
    } catch (error) {
        console.error('Schedule fetch error:', error);
        return null;
    }
}

async function getStreamersInfo(ids) {
    if (!state.isConnected || ids.length === 0) return [];

    try {
        const idsParam = ids.map(id => `id=${id}`).join('&');
        const response = await fetch(
            `${TWITCH_API.apiBase}/users?${idsParam}`,
            {
                headers: {
                    'Authorization': `Bearer ${state.accessToken}`,
                    'Client-Id': state.clientId
                }
            }
        );

        if (!response.ok) throw new Error('Failed to fetch user info');

        const data = await response.json();
        return data.data;
    } catch (error) {
        console.error('User info fetch error:', error);
        return [];
    }
}

async function getChannelVideos(broadcasterId, type = 'archive') {
    if (!state.isConnected) return [];

    try {
        // Fetch recent VODs/archives (past broadcasts)
        const response = await fetch(
            `${TWITCH_API.apiBase}/videos?user_id=${broadcasterId}&type=${type}&first=20`,
            {
                headers: {
                    'Authorization': `Bearer ${state.accessToken}`,
                    'Client-Id': state.clientId
                }
            }
        );

        if (!response.ok) {
            if (response.status === 404) {
                return [];
            }
            throw new Error('Failed to fetch videos');
        }

        const data = await response.json();
        return data.data || [];
    } catch (error) {
        console.error('Videos fetch error:', error);
        return [];
    }
}

// ===== Live Status =====

async function checkLiveStatus() {
    if (!state.isConnected || state.followedStreamers.size === 0) {
        state.liveStreamers.clear();
        return;
    }

    try {
        const ids = Array.from(state.followedStreamers.keys());
        // Twitch API allows up to 100 user_id params per request
        const idsParam = ids.map(id => `user_id=${id}`).join('&');
        
        const response = await fetch(
            `${TWITCH_API.apiBase}/streams?${idsParam}`,
            {
                headers: {
                    'Authorization': `Bearer ${state.accessToken}`,
                    'Client-Id': state.clientId
                }
            }
        );

        if (!response.ok) {
            if (response.status === 401) {
                handleAuthError();
            }
            throw new Error('Failed to fetch live status');
        }

        const data = await response.json();
        
        // Clear and rebuild live streamers map
        state.liveStreamers.clear();
        
        if (data.data) {
            data.data.forEach(stream => {
                state.liveStreamers.set(stream.user_id, {
                    streamId: stream.id,
                    userId: stream.user_id,
                    userName: stream.user_name,
                    login: stream.user_login,
                    gameName: stream.game_name,
                    title: stream.title,
                    viewerCount: stream.viewer_count,
                    startedAt: new Date(stream.started_at),
                    thumbnailUrl: stream.thumbnail_url
                });
            });
        }
        
        // Re-render streamers list to show live status
        renderStreamersList();
        
    } catch (error) {
        console.error('Live status check error:', error);
    }
}

function startLiveStatusCheck() {
    // Check immediately
    checkLiveStatus();
    
    // Then check every 60 seconds
    if (state.liveCheckInterval) {
        clearInterval(state.liveCheckInterval);
    }
    state.liveCheckInterval = setInterval(checkLiveStatus, 60000);
}

function stopLiveStatusCheck() {
    if (state.liveCheckInterval) {
        clearInterval(state.liveCheckInterval);
        state.liveCheckInterval = null;
    }
}

// ===== Authentication =====

function getClientId() {
    // Priority: 1) Embedded Client ID, 2) User-provided (dev mode)
    return TWITCH_API.clientId || localStorage.getItem(STORAGE_KEYS.clientId) || '';
}

function isConfigured() {
    return !!TWITCH_API.clientId;
}

function initiateOAuth() {
    let clientId = getClientId();
    
    // If no embedded Client ID, check user input (dev mode)
    if (!clientId && elements.clientIdInput) {
        clientId = elements.clientIdInput.value.trim();
        if (clientId) {
            localStorage.setItem(STORAGE_KEYS.clientId, clientId);
        }
    }
    
    if (!clientId) {
        showConnectStatus('Client ID not configured', 'error');
        return;
    }

    // Build OAuth URL
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: TWITCH_API.redirectUri,
        response_type: 'token',
        scope: TWITCH_API.scopes.join(' ')
    });

    window.location.href = `${TWITCH_API.authUrl}?${params.toString()}`;
}

function handleOAuthCallback() {
    // Check for token in URL hash
    const hash = window.location.hash.substring(1);
    if (!hash) return false;

    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    const expiresIn = params.get('expires_in');

    if (accessToken) {
        // Calculate expiry time
        const expiry = Date.now() + (parseInt(expiresIn) * 1000);
        
        // Save to localStorage
        localStorage.setItem(STORAGE_KEYS.accessToken, accessToken);
        localStorage.setItem(STORAGE_KEYS.tokenExpiry, expiry.toString());

        // Clear the hash from URL
        history.replaceState(null, '', window.location.pathname);

        return true;
    }

    // Check for error
    const error = params.get('error');
    if (error) {
        console.error('OAuth error:', params.get('error_description'));
        history.replaceState(null, '', window.location.pathname);
    }

    return false;
}

function loadSavedAuth() {
    const accessToken = localStorage.getItem(STORAGE_KEYS.accessToken);
    const clientId = getClientId();
    const tokenExpiry = localStorage.getItem(STORAGE_KEYS.tokenExpiry);

    if (accessToken && clientId) {
        // Check if token is expired
        if (tokenExpiry && Date.now() > parseInt(tokenExpiry)) {
            clearAuth();
            return false;
        }

        state.accessToken = accessToken;
        state.clientId = clientId;
        state.isConnected = true;
        return true;
    }

    return false;
}

function clearAuth() {
    localStorage.removeItem(STORAGE_KEYS.accessToken);
    localStorage.removeItem(STORAGE_KEYS.tokenExpiry);
    state.accessToken = null;
    state.isConnected = false;
    updateConnectionUI();
}

function handleAuthError() {
    clearAuth();
    showConnectStatus('Session expired. Please reconnect.', 'error');
    openConnectModal();
}

function updateConnectionUI() {
    if (state.isConnected) {
        elements.connectBtn.classList.add('connected');
        elements.connectBtnText.textContent = 'Connected';
        elements.searchInput.placeholder = 'Search Twitch streamers...';
    } else {
        elements.connectBtn.classList.remove('connected');
        // Use friendlier text when app is pre-configured
        elements.connectBtnText.textContent = isConfigured() ? 'Login with Twitch' : 'Connect Twitch';
        elements.searchInput.placeholder = isConfigured() ? 'Login to search streamers...' : 'Connect Twitch to search...';
    }
}

function showConnectStatus(message, type = 'info') {
    elements.connectStatus.textContent = message;
    elements.connectStatus.className = `connect-status ${type}`;
}

function openConnectModal() {
    // Check if app is configured with embedded Client ID
    if (isConfigured()) {
        // Simple mode: just show login button
        document.querySelector('.connect-modal .modal-content').innerHTML = `
            <div class="connect-header">
                <svg class="connect-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                    <line x1="16" y1="2" x2="16" y2="6"/>
                    <line x1="8" y1="2" x2="8" y2="6"/>
                    <line x1="3" y1="10" x2="21" y2="10"/>
                    <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>
                </svg>
                <h2>Login with Twitch</h2>
                <p>Connect your Twitch account to search for streamers and view their schedules</p>
            </div>
            <div class="connect-status" id="connect-status"></div>
            <div class="connect-actions">
                <button class="modal-btn modal-btn-primary" id="authorize-btn" onclick="initiateOAuth()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
                        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
                        <polyline points="10 17 15 12 10 7"/>
                        <line x1="15" y1="12" x2="3" y2="12"/>
                    </svg>
                    Continue with Twitch
                </button>
            </div>
            <p class="connect-footer">You'll be redirected to Twitch to authorize this app. We only request permission to see who you follow.</p>
        `;
    } else {
        // Developer mode: show Client ID input
        const savedClientId = localStorage.getItem(STORAGE_KEYS.clientId);
        if (elements.clientIdInput && savedClientId) {
            elements.clientIdInput.value = savedClientId;
        }
        
        // Update redirect URL display
        if (elements.redirectUrl) {
            elements.redirectUrl.textContent = TWITCH_API.redirectUri;
        }
    }
    
    elements.connectModalOverlay.classList.add('active');
}

function closeConnectModal() {
    elements.connectModalOverlay.classList.remove('active');
    elements.connectStatus.textContent = '';
    elements.connectStatus.className = 'connect-status';
}

// ===== Followed Streamers Persistence =====

function saveFollowedStreamers() {
    const data = Array.from(state.followedStreamers.entries());
    localStorage.setItem(STORAGE_KEYS.followedStreamers, JSON.stringify(data));
}

function loadFollowedStreamers() {
    const saved = localStorage.getItem(STORAGE_KEYS.followedStreamers);
    if (saved) {
        try {
            const data = JSON.parse(saved);
            state.followedStreamers = new Map(data);
        } catch (e) {
            console.error('Failed to load followed streamers:', e);
        }
    }
}

// ===== Utility Functions =====

function formatDate(date, format) {
    const options = {
        full: { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' },
        monthYear: { year: 'numeric', month: 'long' },
        short: { month: 'short', day: 'numeric' },
        time: { hour: 'numeric', minute: '2-digit' },
        dayMonth: { month: 'short', day: 'numeric' },
        weekday: { weekday: 'long' }
    };
    return date.toLocaleDateString('en-US', options[format] || options.full);
}

function formatTime(date) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function isSameDay(d1, d2) {
    return d1.getDate() === d2.getDate() &&
           d1.getMonth() === d2.getMonth() &&
           d1.getFullYear() === d2.getFullYear();
}

function isToday(date) {
    return isSameDay(date, new Date());
}

function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    d.setDate(d.getDate() - day);
    d.setHours(0, 0, 0, 0);
    return d;
}

function getMonthStart(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getMonthEnd(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function getDaysInMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

// Debounce function for search
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Format viewer count (e.g., 1234 -> "1.2K")
function formatViewerCount(count) {
    if (count >= 1000000) {
        return (count / 1000000).toFixed(1) + 'M';
    }
    if (count >= 1000) {
        return (count / 1000).toFixed(1) + 'K';
    }
    return count.toString();
}

// ===== Search UI =====

async function handleSearch(query) {
    if (!query.trim()) {
        state.searchResults = [];
        renderSearchResults();
        return;
    }

    if (!state.isConnected) {
        elements.searchResults.innerHTML = `
            <div class="search-message">
                <p>Connect your Twitch account to search for streamers</p>
                <button class="search-connect-btn" onclick="openConnectModal()">Connect Twitch</button>
            </div>
        `;
        elements.searchResults.classList.add('active');
        return;
    }

    // Show loading
    state.isSearching = true;
    elements.searchLoading.classList.add('active');

    const results = await searchChannels(query);
    
    state.searchResults = results;
    state.isSearching = false;
    elements.searchLoading.classList.remove('active');
    
    renderSearchResults();
}

function renderSearchResults() {
    if (state.searchResults.length === 0) {
        if (elements.searchInput.value.trim()) {
            elements.searchResults.innerHTML = `
                <div class="search-message">
                    <p>No streamers found</p>
                </div>
            `;
            elements.searchResults.classList.add('active');
        } else {
            elements.searchResults.classList.remove('active');
        }
        return;
    }

    elements.searchResults.innerHTML = state.searchResults.map(streamer => `
        <div class="search-result-item ${state.followedStreamers.has(streamer.id) ? 'following' : ''}" 
             data-streamer-id="${streamer.id}"
             data-streamer='${JSON.stringify(streamer).replace(/'/g, "&#39;")}'>
            <div class="streamer-avatar">
                ${streamer.profileImage ? 
                    `<img src="${streamer.profileImage}" alt="${streamer.name}">` : 
                    streamer.name.charAt(0).toUpperCase()
                }
            </div>
            <div class="streamer-info">
                <div class="streamer-name">
                    ${streamer.name}
                    ${streamer.isLive ? '<span class="live-indicator">LIVE</span>' : ''}
                </div>
                <div class="streamer-category">${streamer.category}</div>
            </div>
            <div class="follow-indicator">
                ${state.followedStreamers.has(streamer.id) ? `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M20 6L9 17l-5-5"/>
                    </svg>
                ` : `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 5v14M5 12h14"/>
                    </svg>
                `}
            </div>
        </div>
    `).join('');

    elements.searchResults.classList.add('active');

    // Add click handlers
    document.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => {
            const streamer = JSON.parse(item.dataset.streamer.replace(/&#39;/g, "'"));
            toggleFollow(streamer);
        });
    });
}

// ===== Calendar Rendering =====

function updateDateDisplay() {
    const date = state.currentDate;
    switch (state.currentView) {
        case 'day':
            elements.currentDate.textContent = formatDate(date, 'full');
            break;
        case 'week':
            const weekStart = getWeekStart(date);
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekEnd.getDate() + 6);
            if (weekStart.getMonth() === weekEnd.getMonth()) {
                elements.currentDate.textContent = `${formatDate(weekStart, 'dayMonth')} - ${weekEnd.getDate()}, ${weekStart.getFullYear()}`;
            } else {
                elements.currentDate.textContent = `${formatDate(weekStart, 'dayMonth')} - ${formatDate(weekEnd, 'dayMonth')}, ${weekEnd.getFullYear()}`;
            }
            break;
        case 'month':
            elements.currentDate.textContent = formatDate(date, 'monthYear');
            break;
    }
}

async function loadEvents() {
    const followedStreamers = Array.from(state.followedStreamers.values());
    
    let startDate, endDate;
    switch (state.currentView) {
        case 'day':
            startDate = new Date(state.currentDate);
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(state.currentDate);
            endDate.setHours(23, 59, 59, 999);
            break;
        case 'week':
            startDate = getWeekStart(state.currentDate);
            endDate = new Date(startDate);
            endDate.setDate(endDate.getDate() + 7);
            break;
        case 'month':
            startDate = getMonthStart(state.currentDate);
            endDate = getMonthEnd(state.currentDate);
            endDate.setDate(endDate.getDate() + 1);
            break;
    }

    const events = [];

    // Only fetch data if connected and have followed streamers
    if (state.isConnected && followedStreamers.length > 0) {
        // Fetch data for all streamers in parallel
        const fetchPromises = followedStreamers.map(async (streamer) => {
            const streamerEvents = [];
            
            // Fetch scheduled streams
            const schedule = await getChannelSchedule(streamer.id);
            if (schedule && schedule.segments) {
                schedule.segments.forEach((segment, i) => {
                    const segmentStart = new Date(segment.start_time);
                    const segmentEnd = new Date(segment.end_time);
                    
                    // Only include events in our date range
                    if (segmentStart <= endDate && segmentEnd >= startDate) {
                        streamerEvents.push({
                            id: `schedule-${streamer.id}-${segment.id || i}`,
                            streamerId: streamer.id,
                            streamer: streamer,
                            title: segment.title || 'Scheduled Stream',
                            category: segment.category?.name || streamer.category,
                            start: segmentStart,
                            end: segmentEnd,
                            color: streamer.color,
                            isRecurring: segment.is_recurring,
                            type: 'scheduled'
                        });
                    }
                });
            }
            
            // Fetch past streams (VODs/archives)
            const videos = await getChannelVideos(streamer.id, 'archive');
            if (videos && videos.length > 0) {
                videos.forEach((video) => {
                    const videoStart = new Date(video.created_at);
                    // Parse duration (format: "1h2m3s" or "2h30m" etc.)
                    const durationSeconds = parseDuration(video.duration);
                    const videoEnd = new Date(videoStart.getTime() + durationSeconds * 1000);
                    
                    // Only include past streams in our date range
                    if (videoStart <= endDate && videoEnd >= startDate) {
                        streamerEvents.push({
                            id: `vod-${video.id}`,
                            streamerId: streamer.id,
                            streamer: streamer,
                            title: video.title || 'Past Stream',
                            category: streamer.category,
                            start: videoStart,
                            end: videoEnd,
                            color: streamer.color,
                            type: 'past',
                            vodUrl: video.url,
                            viewCount: video.view_count,
                            thumbnailUrl: video.thumbnail_url
                        });
                    }
                });
            }
            
            return streamerEvents;
        });

        // Wait for all fetches to complete
        const allStreamerEvents = await Promise.all(fetchPromises);
        allStreamerEvents.forEach(streamerEvents => {
            events.push(...streamerEvents);
        });
    }

    state.events = events.sort((a, b) => a.start - b.start);
}

// Parse Twitch duration format (e.g., "1h2m3s", "45m", "2h30m")
function parseDuration(duration) {
    if (!duration) return 0;
    
    let seconds = 0;
    const hours = duration.match(/(\d+)h/);
    const minutes = duration.match(/(\d+)m/);
    const secs = duration.match(/(\d+)s/);
    
    if (hours) seconds += parseInt(hours[1]) * 3600;
    if (minutes) seconds += parseInt(minutes[1]) * 60;
    if (secs) seconds += parseInt(secs[1]);
    
    return seconds;
}

async function renderCalendar() {
    await loadEvents();
    updateDateDisplay();
    
    switch (state.currentView) {
        case 'day':
            renderDayView();
            break;
        case 'week':
            renderWeekView();
            break;
        case 'month':
            renderMonthView();
            break;
    }
    
    // Scroll to current time for day/week views
    scrollToCurrentTime();
}

function scrollToCurrentTime() {
    // Only scroll for day and week views
    if (state.currentView === 'month') return;
    
    const now = new Date();
    const currentHour = now.getHours();
    
    // Calculate scroll position: center the current hour on screen
    // Each time slot is 60px (or 50px on mobile)
    const slotHeight = window.innerWidth <= 768 ? 50 : 60;
    const scrollPosition = Math.max(0, (currentHour - 2) * slotHeight); // Show 2 hours before current time
    
    // Find the scrollable element
    const weekBody = document.querySelector('.week-body');
    const dayBody = document.querySelector('.day-body');
    const scrollTarget = weekBody || dayBody;
    
    if (scrollTarget) {
        // Use requestAnimationFrame + setTimeout for reliable mobile scrolling
        requestAnimationFrame(() => {
            setTimeout(() => {
                scrollTarget.scrollTo({
                    top: scrollPosition,
                    behavior: 'instant'
                });
            }, 150);
        });
    }
}

function renderWeekView() {
    const weekStart = getWeekStart(state.currentDate);
    const days = [];
    for (let i = 0; i < 7; i++) {
        const day = new Date(weekStart);
        day.setDate(day.getDate() + i);
        days.push(day);
    }
    
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    let html = `
        <div class="week-header">
            <div class="week-header-cell"></div>
            ${days.map((day, i) => `
                <div class="week-header-cell ${isToday(day) ? 'today' : ''}">
                    <div class="day-name">${dayNames[i]}</div>
                    <div class="day-number">${day.getDate()}</div>
                </div>
            `).join('')}
        </div>
        <div class="week-body">
            <div class="time-column">
                ${Array.from({ length: 24 }, (_, i) => `
                    <div class="time-slot-label">${i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i - 12} PM`}</div>
                `).join('')}
            </div>
            ${days.map((day, dayIndex) => `
                <div class="day-column" data-date="${day.toISOString()}">
                    ${Array.from({ length: 24 }, (_, hour) => `
                        <div class="time-slot" data-hour="${hour}"></div>
                    `).join('')}
                    ${renderDayEvents(day)}
                </div>
            `).join('')}
        </div>
    `;
    
    elements.calendar.innerHTML = html;
    attachEventListeners();
}

function renderDayEvents(day) {
    const dayEvents = state.events.filter(e => isSameDay(e.start, day));
    
    return dayEvents.map(event => {
        const startHour = event.start.getHours() + event.start.getMinutes() / 60;
        const endHour = event.end.getHours() + event.end.getMinutes() / 60;
        const duration = endHour - startHour;
        const top = startHour * 60;
        const height = Math.max(duration * 60, 30);
        const isPast = event.type === 'past';
        
        return `
            <div class="calendar-event color-${event.color} ${isPast ? 'past-event' : ''}" 
                 style="top: ${top}px; height: ${height}px;"
                 data-event-id="${event.id}">
                <div class="event-header">
                    ${isPast ? '<span class="event-badge past">VOD</span>' : '<span class="event-badge scheduled">Scheduled</span>'}
                </div>
                <div class="event-title">${event.title}</div>
                <div class="event-time">${formatTime(event.start)} - ${formatTime(event.end)}</div>
                <div class="event-streamer">
                    <span class="event-streamer-dot" style="background: var(--accent-${event.color === 'purple' ? 'green' : event.color});"></span>
                    ${event.streamer.name}
                </div>
            </div>
        `;
    }).join('');
}

function renderDayView() {
    const day = state.currentDate;
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    
    let html = `
        <div class="day-view">
            <div class="day-header ${isToday(day) ? 'today' : ''}">
                <div class="day-header-date">${formatDate(day, 'dayMonth')}, ${day.getFullYear()}</div>
                <div class="day-header-weekday">${dayNames[day.getDay()]}</div>
            </div>
            <div class="day-body">
                <div class="time-column">
                    ${Array.from({ length: 24 }, (_, i) => `
                        <div class="time-slot-label">${i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i - 12} PM`}</div>
                    `).join('')}
                </div>
                <div class="day-events-column">
                    ${Array.from({ length: 24 }, (_, hour) => `
                        <div class="time-slot" data-hour="${hour}"></div>
                    `).join('')}
                    ${renderDayEvents(day)}
                </div>
            </div>
        </div>
    `;
    
    elements.calendar.innerHTML = html;
    attachEventListeners();
}

function renderMonthView() {
    const monthStart = getMonthStart(state.currentDate);
    const monthEnd = getMonthEnd(state.currentDate);
    const startDay = monthStart.getDay();
    const daysInMonth = getDaysInMonth(state.currentDate);
    
    // Get days from previous month
    const prevMonth = new Date(state.currentDate);
    prevMonth.setMonth(prevMonth.getMonth() - 1);
    const daysInPrevMonth = getDaysInMonth(prevMonth);
    
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    let days = [];
    
    // Previous month days
    for (let i = startDay - 1; i >= 0; i--) {
        const day = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), daysInPrevMonth - i);
        days.push({ date: day, isOtherMonth: true });
    }
    
    // Current month days
    for (let i = 1; i <= daysInMonth; i++) {
        const day = new Date(state.currentDate.getFullYear(), state.currentDate.getMonth(), i);
        days.push({ date: day, isOtherMonth: false });
    }
    
    // Next month days
    const remainingDays = 42 - days.length;
    for (let i = 1; i <= remainingDays; i++) {
        const day = new Date(state.currentDate.getFullYear(), state.currentDate.getMonth() + 1, i);
        days.push({ date: day, isOtherMonth: true });
    }
    
    let html = `
        <div class="month-header">
            ${dayNames.map(name => `<div class="month-header-cell">${name}</div>`).join('')}
        </div>
        <div class="month-body">
            ${days.map(({ date, isOtherMonth }) => {
                const dayEvents = state.events.filter(e => isSameDay(e.start, date));
                const maxVisible = 3;
                
                return `
                    <div class="month-day ${isOtherMonth ? 'other-month' : ''} ${isToday(date) ? 'today' : ''}" 
                         data-date="${date.toISOString()}">
                        <div class="month-day-number">${date.getDate()}</div>
                        <div class="month-events">
                            ${dayEvents.slice(0, maxVisible).map(event => `
                                <div class="month-event color-${event.color} ${event.type === 'past' ? 'past-event' : ''}" data-event-id="${event.id}">
                                    ${event.type === 'past' ? '📼 ' : ''}${formatTime(event.start)} ${event.streamer.name}
                                </div>
                            `).join('')}
                            ${dayEvents.length > maxVisible ? `
                                <div class="month-more-events">+${dayEvents.length - maxVisible} more</div>
                            ` : ''}
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
    
    elements.calendar.innerHTML = html;
    attachEventListeners();
}

// ===== Streamers List =====

function renderStreamersList() {
    const streamers = Array.from(state.followedStreamers.values());
    
    if (streamers.length === 0) {
        elements.streamersList.innerHTML = `
            <div class="empty-following">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                </svg>
                <p>No streamers followed yet</p>
                <span>Search above to find and follow streamers</span>
            </div>
        `;
        updateFollowingCount();
        return;
    }

    // Sort streamers: live ones first
    const sortedStreamers = [...streamers].sort((a, b) => {
        const aLive = state.liveStreamers.has(a.id);
        const bLive = state.liveStreamers.has(b.id);
        if (aLive && !bLive) return -1;
        if (!aLive && bLive) return 1;
        return 0;
    });

    elements.streamersList.innerHTML = sortedStreamers.map(streamer => {
        const liveData = state.liveStreamers.get(streamer.id);
        const isLive = !!liveData;
        const watchUrl = `https://twitch.tv/${streamer.login || streamer.name.toLowerCase()}`;
        
        return `
            <div class="streamer-item following ${isLive ? 'is-live' : ''}" data-streamer-id="${streamer.id}">
                <div class="streamer-avatar ${isLive ? 'live-avatar' : ''}" style="background: linear-gradient(135deg, var(--${streamer.color === 'purple' ? 'purple-primary' : `accent-${streamer.color}`}), var(--bg-tertiary));">
                    ${streamer.profileImage ? 
                        `<img src="${streamer.profileImage}" alt="${streamer.name}">` : 
                        streamer.name.charAt(0).toUpperCase()
                    }
                    ${isLive ? '<span class="avatar-live-dot"></span>' : ''}
                </div>
                <div class="streamer-info">
                    <div class="streamer-name">
                        ${streamer.name}
                        ${isLive ? '<span class="live-indicator">LIVE</span>' : ''}
                    </div>
                    <div class="streamer-category">${isLive ? liveData.gameName || streamer.category : streamer.category}</div>
                    ${isLive ? `<div class="viewer-count">${formatViewerCount(liveData.viewerCount)} watching</div>` : ''}
                </div>
                ${isLive ? `
                    <a href="${watchUrl}" target="_blank" rel="noopener" class="watch-btn" onclick="event.stopPropagation();">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                            <polygon points="5 3 19 12 5 21 5 3"/>
                        </svg>
                        Watch
                    </a>
                ` : `
                    <div class="follow-indicator">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M20 6L9 17l-5-5"/>
                        </svg>
                    </div>
                `}
            </div>
        `;
    }).join('');
    
    updateFollowingCount();
    
    // Add click handlers
    document.querySelectorAll('#streamers-list .streamer-item').forEach(item => {
        item.addEventListener('click', () => {
            const id = item.dataset.streamerId;
            const streamer = state.followedStreamers.get(id);
            if (streamer) {
                toggleFollow(streamer);
            }
        });
    });
}

function toggleFollow(streamer) {
    const wasFollowing = state.followedStreamers.has(streamer.id);
    
    if (wasFollowing) {
        state.followedStreamers.delete(streamer.id);
        state.liveStreamers.delete(streamer.id);
    } else {
        state.followedStreamers.set(streamer.id, streamer);
        // Check live status immediately when adding a new streamer
        if (state.isConnected) {
            checkLiveStatus();
        }
    }
    
    saveFollowedStreamers();
    renderStreamersList();
    renderSearchResults();
    renderCalendar();
}

function updateFollowingCount() {
    elements.followingCount.textContent = `${state.followedStreamers.size} following`;
}

// ===== Event Modal =====

function showEventModal(eventId) {
    const event = state.events.find(e => e.id === eventId);
    if (!event) return;
    
    const isPast = event.type === 'past';
    const watchUrl = isPast && event.vodUrl 
        ? event.vodUrl 
        : `https://twitch.tv/${event.streamer.login || event.streamer.name.toLowerCase()}`;
    
    elements.modalContent.innerHTML = `
        <div class="modal-header">
            <div class="modal-avatar" style="background: linear-gradient(135deg, var(--${event.color === 'purple' ? 'purple-primary' : `accent-${event.color}`}), var(--bg-tertiary));">
                ${event.streamer.profileImage ? 
                    `<img src="${event.streamer.profileImage}" alt="${event.streamer.name}">` : 
                    event.streamer.name.charAt(0).toUpperCase()
                }
            </div>
            <div class="modal-title-group">
                <div class="modal-type-badge ${isPast ? 'past' : 'scheduled'}">
                    ${isPast ? '📼 Past Stream' : '📅 Scheduled'}
                </div>
                <h3>${event.title}</h3>
                <div class="modal-streamer">${event.streamer.name}</div>
            </div>
        </div>
        <div class="modal-details">
            <div class="modal-detail">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                    <line x1="16" y1="2" x2="16" y2="6"/>
                    <line x1="8" y1="2" x2="8" y2="6"/>
                    <line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
                <div class="modal-detail-content">
                    <div class="modal-detail-label">Date</div>
                    <div class="modal-detail-value">${formatDate(event.start, 'full')}</div>
                </div>
            </div>
            <div class="modal-detail">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12,6 12,12 16,14"/>
                </svg>
                <div class="modal-detail-content">
                    <div class="modal-detail-label">${isPast ? 'Streamed' : 'Time'}</div>
                    <div class="modal-detail-value">${formatTime(event.start)} - ${formatTime(event.end)}</div>
                </div>
            </div>
            ${isPast && event.viewCount !== undefined ? `
            <div class="modal-detail">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                </svg>
                <div class="modal-detail-content">
                    <div class="modal-detail-label">Views</div>
                    <div class="modal-detail-value">${event.viewCount.toLocaleString()}</div>
                </div>
            </div>
            ` : `
            <div class="modal-detail">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="23 7 16 12 23 17 23 7"/>
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                </svg>
                <div class="modal-detail-content">
                    <div class="modal-detail-label">Category</div>
                    <div class="modal-detail-value">${event.category || event.streamer.category}</div>
                </div>
            </div>
            `}
        </div>
        <div class="modal-actions">
            <button class="modal-btn modal-btn-secondary" onclick="closeModal()">Close</button>
            <a href="${watchUrl}" 
               target="_blank" 
               class="modal-btn modal-btn-primary">
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                    <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/>
                </svg>
                ${isPast ? 'Watch VOD' : 'Watch on Twitch'}
            </a>
        </div>
    `;
    
    elements.modalOverlay.classList.add('active');
}

function closeModal() {
    elements.modalOverlay.classList.remove('active');
}

// ===== Event Listeners =====

function attachEventListeners() {
    // Calendar event clicks
    document.querySelectorAll('.calendar-event, .month-event').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            showEventModal(el.dataset.eventId);
        });
    });
}

// ===== Navigation =====

function navigate(direction) {
    const date = state.currentDate;
    
    switch (state.currentView) {
        case 'day':
            date.setDate(date.getDate() + direction);
            break;
        case 'week':
            date.setDate(date.getDate() + (direction * 7));
            break;
        case 'month':
            date.setMonth(date.getMonth() + direction);
            break;
    }
    
    renderCalendar();
}

function goToToday() {
    state.currentDate = new Date();
    renderCalendar();
}

function setView(view) {
    state.currentView = view;
    elements.viewBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });
    renderCalendar();
}

// ===== Mobile Tab Navigation =====

function switchMobilePanel(panel) {
    // Update tab buttons
    elements.mobileTabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.panel === panel);
    });
    
    // Show/hide panels
    if (panel === 'calendar') {
        elements.calendarPanel.classList.remove('hidden');
        elements.streamersPanel.classList.remove('active');
    } else {
        elements.calendarPanel.classList.add('hidden');
        elements.streamersPanel.classList.add('active');
    }
}

// ===== Initialize =====

function init() {
    // Check for OAuth callback first
    const isCallback = handleOAuthCallback();
    
    // Load saved auth
    const hasAuth = loadSavedAuth();
    
    // Load followed streamers
    loadFollowedStreamers();
    
    // Update UI
    updateConnectionUI();
    
    // Start checking live status if connected
    if (hasAuth) {
        startLiveStatusCheck();
    }
    
    // Default to Day view on mobile for better usability
    if (window.innerWidth <= 768) {
        setView('day');
    }
    
    // View buttons
    elements.viewBtns.forEach(btn => {
        btn.addEventListener('click', () => setView(btn.dataset.view));
    });
    
    // Mobile tab navigation
    elements.mobileTabs.forEach(tab => {
        tab.addEventListener('click', () => switchMobilePanel(tab.dataset.panel));
    });
    
    // Navigation
    elements.prevBtn.addEventListener('click', () => navigate(-1));
    elements.nextBtn.addEventListener('click', () => navigate(1));
    elements.todayBtn.addEventListener('click', goToToday);
    
    // Search with debounce
    const debouncedSearch = debounce(handleSearch, 300);
    elements.searchInput.addEventListener('input', (e) => {
        debouncedSearch(e.target.value);
    });
    
    // Close search results when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-box') && !e.target.closest('.search-results')) {
            elements.searchResults.classList.remove('active');
        }
    });
    
    // Focus search to show results again
    elements.searchInput.addEventListener('focus', () => {
        if (state.searchResults.length > 0 || elements.searchInput.value.trim()) {
            renderSearchResults();
        }
    });
    
    // Modal
    elements.modalClose.addEventListener('click', closeModal);
    elements.modalOverlay.addEventListener('click', (e) => {
        if (e.target === elements.modalOverlay) closeModal();
    });
    
    // Connect modal
    elements.connectBtn.addEventListener('click', () => {
        if (state.isConnected) {
            // Show disconnect option
            if (confirm('Disconnect from Twitch?')) {
                clearAuth();
            }
        } else {
            openConnectModal();
        }
    });
    elements.connectModalClose.addEventListener('click', closeConnectModal);
    elements.connectModalOverlay.addEventListener('click', (e) => {
        if (e.target === elements.connectModalOverlay) closeConnectModal();
    });
    elements.authorizeBtn.addEventListener('click', initiateOAuth);
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeModal();
            closeConnectModal();
        }
        if (e.key === 'ArrowLeft' && !e.target.matches('input')) navigate(-1);
        if (e.key === 'ArrowRight' && !e.target.matches('input')) navigate(1);
        if (e.key === 't' && !e.target.matches('input')) goToToday();
    });
    
    // Initial render
    renderStreamersList();
    renderCalendar();
    
    // If just connected, close modal and show success
    if (isCallback && hasAuth) {
        closeConnectModal();
    }
}

// Make functions available globally for inline handlers
window.openConnectModal = openConnectModal;
window.closeModal = closeModal;
window.initiateOAuth = initiateOAuth;

// Start the app
document.addEventListener('DOMContentLoaded', init);
