// ==============================================
// TOKEN MANAGEMENT
// ==============================================

async function getValidToken() {
    const token  = localStorage.getItem('access_token');
    const expiry = localStorage.getItem('token_expiry');
    if (!token) { console.warn('⚠️ No token found'); return null; }
    if (expiry && (parseInt(expiry) - Date.now() < 300000)) {
        console.log('⏰ Token expiring soon — refreshing...');
        return await refreshAccessToken();
    }
    return token;
}

async function refreshAccessToken() {
    const refreshToken = localStorage.getItem('refresh_token');
    if (!refreshToken) { handleTokenExpiry(); return null; }
    try {
        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: '2572b4b9181f4c148d3cccfb02b935f7',
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            })
        });
        const data = await response.json();
        if (!response.ok || !data.access_token) { handleTokenExpiry(); return null; }
        localStorage.setItem('access_token', data.access_token);
        if (data.expires_in)    localStorage.setItem('token_expiry',  (Date.now() + data.expires_in * 1000).toString());
        if (data.refresh_token) localStorage.setItem('refresh_token', data.refresh_token);
        if (player && playerInitialized) { player.disconnect(); setTimeout(initializeSpotifyPlayer, 1000); }
        console.log('✅ Token refreshed');
        return data.access_token;
    } catch (err) { console.error('❌ Refresh error:', err); handleTokenExpiry(); return null; }
}

function handleTokenExpiry() {
    localStorage.clear();
    sessionStorage.clear();
    setTimeout(() => { window.location.href = '/index.html'; }, 100);
}

function setupAutoRefresh() {
    const expiry = localStorage.getItem('token_expiry');
    if (!expiry) return;
    const msUntilRefresh = Math.max(0, parseInt(expiry) - Date.now() - 300000);
    setTimeout(async () => { await refreshAccessToken(); setupAutoRefresh(); }, msUntilRefresh);
}

async function checkTokenOnLoad() {
    const token        = localStorage.getItem('access_token');
    const expiry       = localStorage.getItem('token_expiry');
    const refreshToken = localStorage.getItem('refresh_token');
    if (!token) { window.location.href = '/index.html'; return false; }
    if (expiry && Date.now() >= parseInt(expiry)) {
        if (refreshToken) { const t = await refreshAccessToken(); return !!t; }
        else { handleTokenExpiry(); return false; }
    }
    return true;
}

// ==============================================
// SPOTIFY API HELPER
// ==============================================

async function spotifyFetch(url, options = {}) {
    const token = await getValidToken();
    if (!token) { handleTokenExpiry(); return null; }
    try {
        const response = await fetch(url, {
            ...options,
            headers: { ...options.headers, 'Authorization': `Bearer ${token}` }
        });
        if (response.status === 401) {
            const newToken = await refreshAccessToken();
            if (newToken) return spotifyFetch(url, options);
            handleTokenExpiry(); return null;
        }
        if (response.status === 204) return null;
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            console.error(`❌ Spotify API ${response.status}:`, err);
            return null;
        }
        return await response.json();
    } catch (err) { console.error('❌ Network error:', err); return null; }
}

// ==============================================
// PLAYER STATE
// ==============================================

let player            = null;
let currentDeviceId   = null;
let playerInitialized = false;
let currentTrack      = null;
let isPlaying         = false;
let volume            = 0.5;
let currentTrackUri   = null;

const playerState = { track: null, isPlaying: false, progress: 0, duration: 0 };

// Used by player_state_changed to detect a track naturally ending vs a manual pause
let wasPlaying        = false;
let lastKnownPosition = 0;

// ==============================================
// PROGRESS BAR POLLING
// Ticks every second to move the bar smoothly between SDK state_changed events
// ==============================================

let progressInterval = null;

function startProgressPolling() {
    stopProgressPolling();
    progressInterval = setInterval(() => {
        if (!isPlaying || playerState.duration <= 0) return;
        playerState.progress = Math.min(playerState.progress + 1000, playerState.duration);
        updateProgressUI(playerState.progress, playerState.duration);
    }, 1000);
}

function stopProgressPolling() {
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
}

// ==============================================
// PLAYER CONTROLS
// ==============================================

async function togglePlay() {
    if (!player || !currentDeviceId || !playerInitialized) { showNotification('Player not ready'); return; }
    const token = await getValidToken();
    if (!token) { handleTokenExpiry(); return; }
    const endpoint = isPlaying ? 'pause' : 'play';
    try {
        const res = await fetch(
            `https://api.spotify.com/v1/me/player/${endpoint}?device_id=${currentDeviceId}`,
            { method: 'PUT', headers: { 'Authorization': 'Bearer ' + token } }
        );
        if      (res.status === 204) { isPlaying = !isPlaying; updateAllPlayButtons(); }
        else if (res.status === 404) { await reconnectPlayer(); setTimeout(togglePlay, 1000); }
        else    console.error(`❌ togglePlay failed: ${res.status}`);
    } catch (err) { console.error('❌ togglePlay error:', err); }
}

async function playTrack(trackUri, retries = 3) {
    const token = await getValidToken();
    if (!token) { handleTokenExpiry(); return; }
    if (!player || !currentDeviceId || !playerInitialized) {
        if (retries > 0) { setTimeout(() => playTrack(trackUri, retries - 1), 1000); }
        else showNotification('Player not ready — try refreshing');
        return;
    }
    try {
        const res = await fetch(
            `https://api.spotify.com/v1/me/player/play?device_id=${currentDeviceId}`,
            {
                method: 'PUT',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ uris: [trackUri] })
            }
        );
        if (res.status === 204) {
            isPlaying = true; currentTrackUri = trackUri; updateAllPlayButtons();
            const trackId   = trackUri.split(':')[2];
            const trackData = trackId ? await spotifyFetch(`https://api.spotify.com/v1/tracks/${trackId}`) : null;
            if (trackData) {
                currentTrack = trackData;
                saveCurrentTrack(trackData);
                updateNowPlayingUI(trackData);
                updateNowPlayingMenuUI(trackData);
                // Fetch fresh similar songs and artist info for the new track
                fetchSimilarSongs(trackData);
                fetchArtistInfo(trackData.artists[0].id);
                updateCredits(trackData);
            }
        } else if (res.status === 404) {
            await reconnectPlayer(); setTimeout(() => playTrack(trackUri, retries - 1), 1000);
        } else { console.error(`❌ playTrack failed: ${res.status}`); }
    } catch (err) { console.error('❌ playTrack error:', err); }
}

async function nextTrack() {
    if (!currentDeviceId || !playerInitialized) return;
    const token = await getValidToken(); if (!token) { handleTokenExpiry(); return; }
    const res = await fetch(`https://api.spotify.com/v1/me/player/next?device_id=${currentDeviceId}`,
        { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
    if (res.status === 204) setTimeout(getCurrentPlaybackState, 500);
}

async function previousTrack() {
    if (!currentDeviceId || !playerInitialized) return;
    const token = await getValidToken(); if (!token) { handleTokenExpiry(); return; }
    const res = await fetch(`https://api.spotify.com/v1/me/player/previous?device_id=${currentDeviceId}`,
        { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
    if (res.status === 204) setTimeout(getCurrentPlaybackState, 500);
}

async function setVolume(volumeLevel) {
    if (!currentDeviceId || !playerInitialized) return;
    const token = await getValidToken(); if (!token) { handleTokenExpiry(); return; }
    const vol = Math.min(100, Math.max(0, Math.round(volumeLevel * 100)));
    volume = vol / 100;
    const res = await fetch(
        `https://api.spotify.com/v1/me/player/volume?volume_percent=${vol}&device_id=${currentDeviceId}`,
        { method: 'PUT', headers: { 'Authorization': 'Bearer ' + token } });
    if (res.status === 204) updateVolumeUI(volume);
}

async function seekTo(positionMs) {
    if (!currentDeviceId || !playerInitialized) return;
    const token = await getValidToken(); if (!token) { handleTokenExpiry(); return; }
    await fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${positionMs}&device_id=${currentDeviceId}`,
        { method: 'PUT', headers: { 'Authorization': 'Bearer ' + token } });
}

async function reconnectPlayer() {
    if (!player) return false;
    try { await player.connect(); return true; }
    catch (err) { console.error('❌ Reconnect failed:', err); return false; }
}

async function getCurrentPlaybackState() {
    const token = await getValidToken(); if (!token) return;
    const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing',
        { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok || res.status === 204) return;
    const data = await res.json();
    if (data?.item) {
        currentTrack    = data.item;
        isPlaying       = data.is_playing;
        currentTrackUri = data.item.uri;
        playerState.progress = data.progress_ms || 0;
        playerState.duration = data.item.duration_ms;
        saveCurrentTrack(data.item);
        updateNowPlayingUI(data.item);
        updateNowPlayingMenuUI(data.item);
        updateAllPlayButtons();
        updateProgressUI(playerState.progress, playerState.duration);
        if (isPlaying) startProgressPolling();
        fetchSimilarSongs(data.item);
        fetchArtistInfo(data.item.artists[0].id);
        updateCredits(data.item);
    }
}

// ==============================================
// PERSIST NOW PLAYING — save/restore across page loads
// ==============================================

function saveCurrentTrack(track) {
    try { localStorage.setItem('currentTrack', JSON.stringify(track)); }
    catch (e) { /* storage full */ }
}

function restoreCurrentTrack() {
    try {
        const saved = localStorage.getItem('currentTrack');
        if (!saved) return;
        const track = JSON.parse(saved);
        // Restore UI with saved track — no playback started, just visuals
        updateNowPlayingUI(track);
        updateNowPlayingMenuUI(track);
        fetchSimilarSongs(track);
        fetchArtistInfo(track.artists[0].id);
        updateCredits(track);
        currentTrack = track;
        console.log('🔁 Restored last track:', track.name);
    } catch (e) { console.warn('Could not restore track:', e); }
}

// ==============================================
// UI UPDATE HELPERS
// ==============================================

function updateAllPlayButtons() {
    const btn = document.getElementById('play-pause-btn-now-playing-menu');
    if (btn) btn.innerHTML = isPlaying ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
}

function updateNowPlayingUI(track) {
    if (!track) return;
    const songName    = document.getElementById('song-name');
    const artistName  = document.getElementById('song-artiste');
    const albumArt    = document.getElementById('album-song-cover-img');
    const displayName = document.getElementById('playlist-name-display');
    if (songName)    songName.textContent    = track.name                 || '—';
    if (artistName)  artistName.textContent  = track.artists?.[0]?.name   || '—';
    if (displayName) displayName.textContent = track.name                 || 'Now Playing';
    if (albumArt && track.album?.images?.[0]?.url) {
        albumArt.src = track.album.images[0].url;
        albumArt.alt = track.name;
    }
}

function updateNowPlayingMenuUI(track) {
    if (!track) return;
    const nameEl   = document.querySelector('.song-name-now-playing');
    const artistEl = document.querySelector('.artist-name-now-playing');
    const imageEl  = document.querySelector('.song-now-playing-image');
    if (nameEl)   nameEl.textContent   = track.name                 || '—';
    if (artistEl) artistEl.textContent = track.artists?.[0]?.name   || '—';
    if (imageEl && track.album?.images?.[0]?.url) {
        imageEl.style.backgroundImage    = `url('${track.album.images[0].url}')`;
        imageEl.style.backgroundSize     = 'cover';
        imageEl.style.backgroundPosition = 'center';
    }
}

function updateVolumeUI(volumeLevel) {
    const slider = document.getElementById('volume-slider-now-playing-menu');
    if (slider) slider.value = volumeLevel * 100;
}

function updateProgressUI(progressMs, durationMs) {
    const range = document.getElementById('now-playing-range');
    const spans = document.querySelectorAll('.now-playing-progress-display span');
    if (range && durationMs > 0) range.value = (progressMs / durationMs) * 100;
    if (spans.length === 2) {
        spans[0].textContent = formatTime(progressMs);
        spans[1].textContent = formatTime(durationMs);
    }
}

// Update credits panel from track data
function updateCredits(track) {
    const container = document.getElementById('credits-container');
    if (!container || !track) return;
    container.innerHTML = '';
    track.artists?.forEach(artist => {
        const holder = document.createElement('div');
        holder.className = 'credit-holder';
        holder.innerHTML = `
            <div class="credit-text-contain">
                <span class="credit-artist-name">${artist.name}</span>
                <span class="credit-role">${artist.id === track.artists[0].id ? 'Main Artist' : 'Featured Artist'}</span>
            </div>
            <div class="credit-btn-holder">
                <span class="credit-follow-btn">Follow</span>
            </div>
        `;
        container.appendChild(holder);
    });
}

function formatTime(ms) {
    if (!ms || ms < 0) return '0:00';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function showNotification(msg) { console.log('🔔', msg); }

// ==============================================
// DATA FETCH FUNCTIONS
// ==============================================

// Recently played — deduplicates since Spotify returns same track multiple times
async function fetchRecentlyPlayed() {
    const container = document.getElementById('new-releases-for-you-contain');
    if (!container) return;

    const data = await spotifyFetch('https://api.spotify.com/v1/me/player/recently-played?limit=50');
    if (!data?.items?.length) {
        container.innerHTML = '<p style="color:var(--text-fade);padding:0.5em">No recent tracks found — play something on Spotify first!</p>';
        return;
    }

    // Deduplicate by track ID — keep first occurrence (most recent)
    const seen  = new Set();
    const unique = data.items.filter(({ track }) => {
        if (seen.has(track.id)) return false;
        seen.add(track.id); return true;
    }).slice(0, 10);

    container.innerHTML = '';
    unique.forEach(({ track }) => {
        const card     = document.createElement('div');
        card.className = 'new-releases-card';
        const img      = track.album?.images?.[0]?.url || '';
        card.innerHTML = `
            <div class="new-release-card-image-btn"
                 style="background-image:url('${img}');background-size:cover;background-position:center">
                <span class="new-release-play-btn" data-uri="${track.uri}">
                    <i class="fa-solid fa-play"></i>
                </span>
            </div>
            <span class="new-releases-song-name">${track.name}</span>
            <span class="new-releases-artist">${track.artists?.[0]?.name || ''}</span>
        `;
        card.querySelector('.new-release-play-btn').addEventListener('click', (e) => {
            e.stopPropagation(); playTrackAndQueue(track, unique.map(i => i.track));
        });
        container.appendChild(card);
    });
}

// Top tracks grid on Home
async function fetchTopTracks() {
    const container = document.querySelector('.home-playlist-card-holder');
    if (!container) return;
    const data = await spotifyFetch('https://api.spotify.com/v1/me/top/tracks?limit=8');
    if (!data?.items?.length) {
        container.innerHTML = '<p style="color:var(--text-fade)">No top tracks yet — keep listening!</p>';
        return;
    }
    container.innerHTML = '';
    data.items.forEach(track => {
        const card     = document.createElement('div');
        card.className = 'home-playlist-card';
        const img      = track.album?.images?.[0]?.url || '';
        card.innerHTML = `
            <img src="${img}" alt="${track.name}" class="home-playlist-card-img">
            <span class="home-playlist-card-text">${track.name}</span>
        `;
        card.addEventListener('click', () => playTrackAndQueue(track, data.items));
        container.appendChild(card);
    });
}

// Browse categories — fills Browse page + Search category grid
async function fetchBrowseCategories() {
    const data = await spotifyFetch('https://api.spotify.com/v1/browse/categories?limit=12&locale=en_US');
    const fallbackColors = ['#E1118C','#195E2E','#C626C6','#1E3264','#E8115B','#8D67AB','#148A08','#BA5D07','#BC316B','#E91429','#777777','#477E96'];
    function buildCards(containerEl, items) {
        if (!containerEl) return;
        containerEl.innerHTML = '';
        items.forEach((cat, i) => {
            const card = document.createElement('div');
            card.className = 'browse-cards';
            card.style.backgroundColor = fallbackColors[i % fallbackColors.length];
            const img = cat.icons?.[0]?.url || '';
            card.innerHTML = `
                <span class="browse-card-text">${cat.name}</span>
                ${img ? `<img src="${img}" alt="${cat.name}" class="browse-card-img">` : ''}
            `;
            containerEl.appendChild(card);
        });
    }
    if (data?.categories?.items) {
        buildCards(document.getElementById('browse-card-container'), data.categories.items);
        buildCards(document.getElementById('search-category-grid'),  data.categories.items);
    }
}

// Similar songs — uses Spotify recommendations seeded by current track + artist
async function fetchSimilarSongs(track) {
    const container = document.getElementById('similar-songs-container');
    if (!container || !track) return;

    const trackId  = track.id;
    const artistId = track.artists?.[0]?.id;
    if (!trackId) return;

    const params = new URLSearchParams({
        seed_tracks:  trackId,
        seed_artists: artistId || '',
        limit: 5
    });

    const data = await spotifyFetch(`https://api.spotify.com/v1/recommendations?${params}`);
    if (!data?.tracks?.length) {
        container.innerHTML = '<p style="color:var(--text-fade);font-size:0.85rem">No similar songs found</p>';
        return;
    }

    // Update the "Songs like:" label
    const label = document.querySelector('.similar-songs-text');
    if (label) label.textContent = `Songs like: ${track.name}`;

    container.innerHTML = '';
    data.tracks.forEach(rec => {
        const img  = rec.album?.images?.[0]?.url || '';
        const card = document.createElement('div');
        card.className = 'similar-song-card';
        card.innerHTML = `
            <div class="similar-song-background-holder"
                 style="background-image:linear-gradient(rgba(0,0,0,0),rgba(0,0,0,0)),url('${img}');background-size:cover;background-position:center">
                <i class="fa-solid fa-play"></i>
            </div>
            <div class="pseudo-container">
                <div class="similar-song-info">
                    <span class="similar-song-name">${rec.name}</span>
                    <span class="similar-song-artist">${rec.artists?.[0]?.name || ''}</span>
                </div>
                <span class="more-options"><i class="fa-solid fa-ellipsis"></i></span>
            </div>
        `;
        // Click the image area to play
        card.querySelector('.similar-song-background-holder').addEventListener('click', () => playTrack(rec.uri));
        container.appendChild(card);
    });
}

// About artist — fetches real artist data from Spotify
async function fetchArtistInfo(artistId) {
    if (!artistId) return;

    const data = await spotifyFetch(`https://api.spotify.com/v1/artists/${artistId}`);
    if (!data) return;

    const banner    = document.getElementById('about-artist-banner');
    const nameEl    = document.getElementById('about-artist-name');
    const listeners = document.getElementById('about-artist-listeners');
    const descEl    = document.getElementById('about-artist-desc');

    if (nameEl)    nameEl.textContent    = data.name || '—';
    // Spotify doesn't provide monthly listeners or bio in the API — show followers instead
    if (listeners) listeners.textContent = data.followers?.total
        ? `${data.followers.total.toLocaleString()} followers`
        : '—';
    if (descEl)    descEl.textContent    = data.genres?.length
        ? `Genres: ${data.genres.slice(0, 3).join(', ')}`
        : '';

    // Use artist image as banner if available
    if (banner && data.images?.[0]?.url) {
        banner.style.backgroundImage    = `url('${data.images[0].url}')`;
        banner.style.backgroundSize     = 'cover';
        banner.style.backgroundPosition = 'center top';
    }
}

// User profile — populates profile button and dropdown
async function fetchUserProfile() {
    const data = await spotifyFetch('https://api.spotify.com/v1/me');
    if (!data) return;

    console.log('✅ Logged in as:', data.display_name);

    // Navbar button
    const profileName    = document.getElementById('profile-name');
    const profileAvatar  = document.getElementById('profile-avatar');
    const profileFallback= document.getElementById('profile-avatar-fallback');

    if (profileName) profileName.textContent = data.display_name || 'Account';

    if (data.images?.[0]?.url) {
        profileAvatar.src = data.images[0].url;
        profileAvatar.classList.remove('is-hidden');
        profileFallback?.classList.add('is-hidden');
    }

    // Dropdown
    const dropName   = document.getElementById('profile-dropdown-name');
    const dropEmail  = document.getElementById('profile-dropdown-email');
    const dropAvatar = document.getElementById('profile-dropdown-avatar');

    if (dropName)  dropName.textContent  = data.display_name || '—';
    if (dropEmail) dropEmail.textContent = data.email        || '—';

    if (data.images?.[0]?.url && dropAvatar) {
        dropAvatar.src = data.images[0].url;
        dropAvatar.classList.remove('is-hidden');
    }
}

// ==============================================
// PROFILE DROPDOWN TOGGLE
// ==============================================

const profileBtn      = document.getElementById('profile-btn');
const profileDropdown = document.getElementById('profile-dropdown');
const profileChevron  = document.getElementById('profile-chevron');

function toggleDropdown(open) {
    if (open) {
        profileDropdown?.classList.remove('is-hidden');
        profileChevron?.classList.add('open');
    } else {
        profileDropdown?.classList.add('is-hidden');
        profileChevron?.classList.remove('open');
    }
}

profileBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !profileDropdown?.classList.contains('is-hidden');
    toggleDropdown(!isOpen);
});

// Close dropdown when clicking anywhere outside
document.addEventListener('click', () => toggleDropdown(false));

// ==============================================
// SEARCH — dedicated page
// ==============================================

const searchInput      = document.getElementById('search-input');
const searchResultsSec = document.getElementById('search-results-section');
const searchCategories = document.getElementById('search-browse-categories');
const searchClearBtn   = document.getElementById('search-clear-btn');
let   searchDebounce   = null;

function showSearchResults()    { searchResultsSec?.classList.remove('is-hidden'); searchCategories?.classList.add('is-hidden'); }
function showSearchCategories() { searchResultsSec?.classList.add('is-hidden');    searchCategories?.classList.remove('is-hidden'); }

if (searchInput) {
    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim();
        searchClearBtn?.classList.toggle('visible', query.length > 0);
        if (!query) { showSearchCategories(); return; }
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => searchSpotify(query), 400);
    });
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') { clearTimeout(searchDebounce); searchSpotify(searchInput.value.trim()); }
    });
}

searchClearBtn?.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    searchClearBtn.classList.remove('visible');
    showSearchCategories();
    const c = document.getElementById('search-results-container');
    if (c) c.innerHTML = '';
});

async function searchSpotify(query) {
    if (!query) return;
    const container = document.getElementById('search-results-container');
    if (!container) return;
    showSearchResults();
    container.innerHTML = '<p style="color:var(--text-fade);padding:1em">Searching...</p>';
    const data = await spotifyFetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=8`);
    if (!data) { container.innerHTML = '<p style="color:var(--text-fade);padding:1em">Search failed — try again</p>'; return; }
    displaySearchResults(data.tracks?.items || []);
}

function displaySearchResults(tracks) {
    const container = document.getElementById('search-results-container');
    if (!container) return;
    container.innerHTML = '';
    if (!tracks.length) { container.innerHTML = '<p style="color:var(--text-fade);padding:1em">No results found</p>'; return; }
    tracks.forEach(track => {
        const card = document.createElement('div');
        card.className = 'track-card';
        const img  = track.album?.images?.[0]?.url || '';
        card.innerHTML = `
            <img src="${img}" alt="${track.name}" width="50" height="50">
            <div class="track-info">
                <h4>${track.name}</h4>
                <p>${track.artists?.[0]?.name || ''}</p>
            </div>
            <span class="track-card-add-btn" title="Add to playlist">
                <i class="fa-solid fa-plus"></i>
            </span>
            <button class="play-btn" data-uri="${track.uri}">▶ Play</button>
        `;
        card.querySelector('.play-btn').addEventListener('click', (e) => { e.stopPropagation(); playTrackAndQueue(track, tracks); });
        card.querySelector('.track-card-add-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openAddToPlaylistModal(track.uri);
        });
        card.addEventListener('click', () => playTrackAndQueue(track, tracks));
        container.appendChild(card);
    });
}

// ==============================================
// NAVIGATION / VIEWS
// ==============================================

function switchView(viewId, buttonId) {
    document.querySelectorAll('.view-content').forEach(v => v.classList.add('is-hidden'));
    const target = document.getElementById(viewId);
    if (target) {
        target.classList.remove('is-hidden');
        if (viewId)   localStorage.setItem('lastView',   viewId);
        if (buttonId) localStorage.setItem('lastButton', buttonId);
    }
}

const navMap = {
    'btn-home':              'home-menu-display-container',
    'btn-search-sidebar':    'search-menu-display-container',
    'btn-browse-sidebar':    'browse-menu-display-container',
    'btn-nowPlaying-sidebar':'now-playing-menu-display-container',
};

Object.keys(navMap).forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.addEventListener('click', () => {
            switchView(navMap[btnId], btnId);
            resetActiveButtons();
            btn.classList.add('active');
        });
    }
});

function resetActiveButtons() {
    Object.keys(navMap).forEach(id => document.getElementById(id)?.classList.remove('active'));
}

// ==============================================
// SIDEBAR COLLAPSE
// ==============================================

const mainEl      = document.getElementById('main');
const collapseBtn = document.querySelector('.collapse-btn-sidebar');

if (mainEl && collapseBtn) {
    if (localStorage.getItem('sidebarCollapsed') === 'true') {
        mainEl.classList.add('collapsed-style');
        collapseBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
    }
    collapseBtn.addEventListener('click', () => {
        mainEl.classList.toggle('collapsed-style');
        const collapsed = mainEl.classList.contains('collapsed-style');
        localStorage.setItem('sidebarCollapsed', collapsed);
        collapseBtn.innerHTML = collapsed ? '<i class="fa-solid fa-chevron-right"></i>' : '<i class="fa-solid fa-chevron-left"></i>';
    });
}

// ==============================================
// THEME TOGGLE
// ==============================================

const themeToggleBtn       = document.getElementById('theme-toggle-btn');
const themeToggleBtnMobile = document.getElementById('theme-toggle-btn-mobile');

function setTheme(isLight) {
    document.body.classList.toggle('light-mode', isLight);
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    const icon = isLight ? '<i class="fa-regular fa-moon"></i>' : '<i class="fa-regular fa-sun"></i>';
    if (themeToggleBtn)       themeToggleBtn.innerHTML       = icon;
    if (themeToggleBtnMobile) themeToggleBtnMobile.innerHTML = icon;
}

if (localStorage.getItem('theme') === 'light') setTheme(true);
themeToggleBtn?.addEventListener('click',       () => setTheme(!document.body.classList.contains('light-mode')));
themeToggleBtnMobile?.addEventListener('click', () => setTheme(!document.body.classList.contains('light-mode')));

// ==============================================
// RECENTLY PLAYED SCROLL
// ==============================================

const recentContainer = document.getElementById('new-releases-for-you-contain');
const scrollAmount    = 500;
document.getElementById('new-releases-scroll-left')?.addEventListener('click',  () => recentContainer?.scrollBy({ left: -scrollAmount, behavior: 'smooth' }));
document.getElementById('new-releases-scroll-right')?.addEventListener('click', () => recentContainer?.scrollBy({ left:  scrollAmount, behavior: 'smooth' }));

// ==============================================
// PLAYER CONTROLS — wire up UI
// ==============================================

function setupPlayerControls() {
    document.getElementById('play-pause-btn-now-playing-menu')?.addEventListener('click', togglePlay);
    document.querySelector('.fa-forward-step')?.parentElement?.addEventListener('click',  nextTrack);
    document.querySelector('.fa-backward-step')?.parentElement?.addEventListener('click', previousTrack);
    document.getElementById('volume-slider-now-playing-menu')?.addEventListener('input',  (e) => setVolume(parseInt(e.target.value) / 100));

    // Pause polling while user drags the seek bar
    document.getElementById('now-playing-range')?.addEventListener('input', (e) => {
        if (playerState.duration > 0) {
            stopProgressPolling();
            const posMs = Math.floor((parseInt(e.target.value) / 100) * playerState.duration);
            playerState.progress = posMs;
            updateProgressUI(posMs, playerState.duration);
        }
    });
    // Seek + resume polling on release
    document.getElementById('now-playing-range')?.addEventListener('change', (e) => {
        if (playerState.duration > 0) {
            const posMs = Math.floor((parseInt(e.target.value) / 100) * playerState.duration);
            seekTo(posMs);
            if (isPlaying) startProgressPolling();
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
        if (e.code === 'Space')      { e.preventDefault(); togglePlay(); }
        if (e.code === 'ArrowRight') { e.preventDefault(); nextTrack(); }
        if (e.code === 'ArrowLeft')  { e.preventDefault(); previousTrack(); }
    });
}

document.getElementById('collapse-info-screen-btn')?.addEventListener('click', () => {
    switchView('home-menu-display-container', 'btn-home');
    resetActiveButtons();
    document.getElementById('btn-home')?.classList.add('active');
});

// ==============================================
// LOGOUT
// ==============================================

document.getElementById('logout-btn')?.addEventListener('click', () => {
    stopProgressPolling();
    player?.disconnect();
    localStorage.clear();
    sessionStorage.clear();
    window.location.href = '/index.html';
});

// ==============================================
// SPOTIFY WEB PLAYBACK SDK
// ==============================================

function initializeSpotifyPlayer() {
    if (typeof Spotify === 'undefined' || !Spotify.Player) {
        setTimeout(initializeSpotifyPlayer, 1000); return;
    }
    const token = localStorage.getItem('access_token');
    if (!token) { handleTokenExpiry(); return; }

    console.log('🎵 Initialising Spotify Player...');
    player = new Spotify.Player({
        name: 'SIA.play Web Player',
        getOAuthToken: async (cb) => { cb(await getValidToken() || token); },
        volume
    });

    player.addListener('ready', ({ device_id }) => {
        console.log('✅ Player ready — device:', device_id);
        currentDeviceId = device_id; playerInitialized = true;
        setTimeout(getCurrentPlaybackState, 1000);
    });
    player.addListener('not_ready', ({ device_id }) => {
        console.warn('⚠️ Device offline:', device_id);
        currentDeviceId = null; playerInitialized = false; stopProgressPolling();
    });
    player.addListener('initialization_error', ({ message }) => console.error('❌ Init error:', message));
    player.addListener('authentication_error',  ({ message }) => { console.error('❌ Auth error:', message); handleTokenExpiry(); });
    player.addListener('account_error',         ({ message }) => { console.error('❌ Account error:', message); showNotification('Spotify Premium required'); });

    player.addListener('player_state_changed', (state) => {
        if (!state) return;
        const track = state.track_window?.current_track;
        if (!track) return;

        const trackChanged = currentTrackUri !== track.uri;

        // Detect natural end-of-track: SDK reports paused + position reset to ~0
        // right after we were playing the same track near its end. This is what
        // happens after a single playTrack() call with nothing queued — Spotify
        // has nothing of its own to advance to, so it just stops.
        const looksLikeNaturalEnd =
            !trackChanged &&
            wasPlaying &&
            state.paused &&
            state.position < 1000 &&
            lastKnownPosition > (track.duration_ms - 2000);

        wasPlaying        = !state.paused;
        lastKnownPosition = state.position;

        currentTrack    = track;
        isPlaying       = !state.paused;
        currentTrackUri = track.uri;
        playerState.track     = track;
        playerState.isPlaying = isPlaying;
        playerState.progress  = state.position; // sync exact position from Spotify
        playerState.duration  = track.duration_ms;

        saveCurrentTrack(track);
        updateNowPlayingUI(track);
        updateNowPlayingMenuUI(track);
        updateAllPlayButtons();
        updateProgressUI(state.position, track.duration_ms);

        // Only refetch similar songs / artist if track actually changed
        if (trackChanged) {
            fetchSimilarSongs(track);
            fetchArtistInfo(track.artists[0].id);
            updateCredits(track);
            refreshQueueModalIfOpen();
        }

        if (isPlaying) startProgressPolling(); else stopProgressPolling();

        // Handle what happens after a track naturally finishes
        if (looksLikeNaturalEnd) {
            handleTrackEnded();
        }
    });

    player.connect().then(ok => console.log(ok ? '✅ Connected to Spotify' : '❌ Connection failed'));
}

window.onSpotifyWebPlaybackSDKReady = () => {
    console.log('🎵 Spotify SDK ready');
    initializeSpotifyPlayer();
};

// ==============================================
// INITIALISATION
// ==============================================

window.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 SIA.play starting...');

    const tokenOk = await checkTokenOnLoad();
    if (!tokenOk) return;

    // Restore last view
    const savedView   = localStorage.getItem('lastView');
    const savedButton = localStorage.getItem('lastButton');
    if (savedView) {
        switchView(savedView, savedButton);
        document.getElementById(savedButton)?.classList.add('active');
    } else {
        switchView('home-menu-display-container', 'btn-home');
        document.getElementById('btn-home')?.classList.add('active');
    }

    setupPlayerControls();
    setupAutoRefresh();

    // Restore last playing track visuals immediately before API responds
    restoreCurrentTrack();

    // Fire all API calls
    fetchRecentlyPlayed();
    fetchTopTracks();
    fetchBrowseCategories();
    fetchUserProfile();

    if (typeof Spotify !== 'undefined' && Spotify.Player) initializeSpotifyPlayer();

    console.log('✅ SIA.play ready');
});

window.addEventListener('unhandledrejection', (e) => console.error('❌ Unhandled rejection:', e.reason));

// ==============================================
// STAGE 1: PLAYLISTS — create, library, add-to-playlist, detail view
// ==============================================

let currentUserId   = null;   // cached after fetchUserProfile
let userPlaylists   = [];     // cached list from fetchUserPlaylists
let libraryMode     = false;  // tracks whether Browse container is showing Library instead
let pendingAddUri   = null;   // track uri waiting to be added when Add-to-Playlist modal is open
let selectedImageBase64 = null; // base64 payload for playlist cover upload

// ---------- FETCH USER PLAYLISTS ----------

async function fetchUserPlaylists() {
    const data = await spotifyFetch('https://api.spotify.com/v1/me/playlists?limit=50');
    userPlaylists = data?.items || [];
    return userPlaylists;
}

// ---------- RENDER "YOUR LIBRARY" INTO THE BROWSE CONTAINER ----------

async function renderLibrary(skipModeSave) {
    if (!skipModeSave) localStorage.setItem('lastBrowseMode', 'library');
    const container = document.getElementById('browse-card-container');
    const title     = document.getElementById('browse-page-title');
    if (!container) return;

    if (title) title.textContent = 'Your Library';
    libraryMode = true;

    await fetchUserPlaylists();

    if (!userPlaylists.length) {
        container.innerHTML = '<p class="playlist-empty-state" style="grid-column:1/-1">No playlists yet — create one to get started!</p>';
        return;
    }

    const fallbackColors = ['#E1118C','#195E2E','#C626C6','#1E3264','#E8115B','#8D67AB','#148A08','#BA5D07','#BC316B','#E91429','#777777','#477E96'];

    container.innerHTML = '';
    userPlaylists.forEach((pl, i) => {
        const img  = pl.images?.[0]?.url || '';
        const card = document.createElement('div');
        card.className = 'browse-cards';
        card.style.backgroundColor = fallbackColors[i % fallbackColors.length];
        card.style.position = 'relative';
        card.innerHTML = `
            ${img ? `<img src="${img}" class="library-card-img-real" alt="${pl.name}">` : ''}
            <span class="browse-card-text library-card-content">${pl.name}</span>
        `;
        card.addEventListener('click', () => openPlaylistDetail(pl.id));
        container.appendChild(card);
    });
}

// Restore Browse container back to genre browsing (e.g. when Browse sidebar btn clicked again)
async function renderBrowseCategories() {
    localStorage.setItem('lastBrowseMode', 'categories');
    const title = document.getElementById('browse-page-title');
    if (title) title.textContent = 'Browse All';
    libraryMode = false;
    await fetchBrowseCategories();
}

// ---------- CREATE PLAYLIST MODAL ----------

const createPlaylistModal   = document.getElementById('create-playlist-modal');
const playlistNameInput     = document.getElementById('playlist-name-input');
const playlistImageUpload   = document.getElementById('playlist-image-upload');
const playlistImageInput    = document.getElementById('playlist-image-input');
const playlistImagePreview  = document.getElementById('playlist-image-preview');
const playlistImagePlaceholder = document.getElementById('playlist-image-placeholder');
const createPlaylistError   = document.getElementById('create-playlist-error');
const createPlaylistConfirm = document.getElementById('create-playlist-confirm');

function openCreatePlaylistModal() {
    if (!createPlaylistModal) return;
    // Reset form
    if (playlistNameInput) playlistNameInput.value = '';
    selectedImageBase64 = null;
    playlistImagePreview?.classList.add('is-hidden');
    playlistImagePlaceholder?.classList.remove('is-hidden');
    createPlaylistError?.classList.add('is-hidden');
    createPlaylistModal.classList.remove('is-hidden');
}

function closeCreatePlaylistModal() {
    createPlaylistModal?.classList.add('is-hidden');
}

document.getElementById('btn-create-playlist')?.addEventListener('click', openCreatePlaylistModal);
document.getElementById('create-playlist-close')?.addEventListener('click', closeCreatePlaylistModal);
document.getElementById('create-playlist-cancel')?.addEventListener('click', closeCreatePlaylistModal);
createPlaylistModal?.addEventListener('click', (e) => { if (e.target === createPlaylistModal) closeCreatePlaylistModal(); });

// Click upload box -> trigger hidden file input
playlistImageUpload?.addEventListener('click', () => playlistImageInput?.click());

// Read selected image as base64 (Spotify requires raw base64 JPEG, no data: prefix)
playlistImageInput?.addEventListener('change', () => {
    const file = playlistImageInput.files?.[0];
    if (!file) return;

    if (file.size > 256 * 1024) {
        // Spotify caps custom playlist images around 256KB encoded
        createPlaylistError.textContent = 'Image too large — please use a smaller file (under 256KB).';
        createPlaylistError.classList.remove('is-hidden');
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        const fullDataUrl = reader.result; // e.g. "data:image/jpeg;base64,/9j/4AAQ..."
        selectedImageBase64 = fullDataUrl.split(',')[1]; // strip the data: prefix for the API call
        playlistImagePreview.src = fullDataUrl;
        playlistImagePreview.classList.remove('is-hidden');
        playlistImagePlaceholder.classList.add('is-hidden');
        createPlaylistError.classList.add('is-hidden');
    };
    reader.readAsDataURL(file);
});

createPlaylistConfirm?.addEventListener('click', async () => {
    const name = playlistNameInput?.value.trim();
    if (!name) {
        createPlaylistError.textContent = 'Please enter a playlist name.';
        createPlaylistError.classList.remove('is-hidden');
        return;
    }

    createPlaylistConfirm.disabled = true;
    createPlaylistConfirm.textContent = 'Creating...';

    const playlist = await createPlaylist(name, selectedImageBase64);

    createPlaylistConfirm.disabled = false;
    createPlaylistConfirm.textContent = 'Create';

    if (!playlist) {
        createPlaylistError.textContent = 'Something went wrong — please try again.';
        createPlaylistError.classList.remove('is-hidden');
        return;
    }

    closeCreatePlaylistModal();
    // Refresh library view and open the new playlist
    await renderLibrary();
    openPlaylistDetail(playlist.id);
});

// Creates the playlist on Spotify, then uploads the cover image if one was chosen
async function createPlaylist(name, imageBase64) {
    if (!currentUserId) {
        const profile = await spotifyFetch('https://api.spotify.com/v1/me');
        if (!profile) return null;
        currentUserId = profile.id;
    }

    const playlist = await spotifyFetch(`https://api.spotify.com/v1/users/${currentUserId}/playlists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, public: false })
    });

    if (!playlist) return null;

    // Upload custom cover image if provided — separate endpoint, raw base64 body
    if (imageBase64) {
        const token = await getValidToken();
        try {
            await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/images`, {
                method: 'PUT',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'image/jpeg' },
                body: imageBase64
            });
        } catch (err) {
            console.warn('⚠️ Cover image upload failed (playlist still created):', err);
        }
    }

    return playlist;
}

// ---------- ADD TO PLAYLIST MODAL ----------

const addToPlaylistModal = document.getElementById('add-to-playlist-modal');
const addToPlaylistList  = document.getElementById('add-to-playlist-list');

async function openAddToPlaylistModal(trackUri) {
    if (!addToPlaylistModal || !trackUri) return;
    pendingAddUri = trackUri;

    addToPlaylistList.innerHTML = '<p style="color:var(--text-fade);padding:0.5em">Loading playlists...</p>';
    addToPlaylistModal.classList.remove('is-hidden');

    await fetchUserPlaylists();

    if (!userPlaylists.length) {
        addToPlaylistList.innerHTML = '<p style="color:var(--text-fade);padding:0.5em">No playlists yet — create one first!</p>';
        return;
    }

    addToPlaylistList.innerHTML = '';
    userPlaylists.forEach(pl => {
        const img  = pl.images?.[0]?.url || '';
        const item = document.createElement('div');
        item.className = 'add-to-playlist-item';
        item.innerHTML = `
            ${img ? `<img src="${img}" alt="${pl.name}">` : '<div style="width:42px;height:42px;border-radius:6px;background-color:var(--button-color)"></div>'}
            <span class="add-to-playlist-item-name">${pl.name}</span>
            <span class="add-to-playlist-item-check"><i class="fa-solid fa-check"></i></span>
        `;
        item.addEventListener('click', async () => {
            const ok = await addTrackToPlaylist(pl.id, pendingAddUri);
            if (ok) {
                item.classList.add('is-added');
                showNotification(`Added to ${pl.name}`);
                setTimeout(() => closeAddToPlaylistModal(), 500);
            }
        });
        addToPlaylistList.appendChild(item);
    });
}

function closeAddToPlaylistModal() {
    addToPlaylistModal?.classList.add('is-hidden');
    pendingAddUri = null;
}

document.getElementById('add-to-playlist-close')?.addEventListener('click', closeAddToPlaylistModal);
addToPlaylistModal?.addEventListener('click', (e) => { if (e.target === addToPlaylistModal) closeAddToPlaylistModal(); });

// "New playlist" quick option inside the Add-to-Playlist modal
document.getElementById('add-to-playlist-new-btn')?.addEventListener('click', () => {
    closeAddToPlaylistModal();
    openCreatePlaylistModal();
    // After creating, the track isn't auto-added — straightforward flow, user can re-open Add-to-Playlist
});

async function addTrackToPlaylist(playlistId, trackUri) {
    if (!playlistId || !trackUri) return false;
    const result = await spotifyFetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: [trackUri] })
    });
    return result !== null;
}

// Wire the "save" (add to playlist) button in the Now Playing right panel
document.getElementById('song-save-btn')?.addEventListener('click', () => {
    if (currentTrackUri) openAddToPlaylistModal(currentTrackUri);
    else showNotification('No track currently playing');
});

// ---------- PLAYLIST DETAIL VIEW ----------

let currentOpenPlaylistId = null;

async function openPlaylistDetail(playlistId) {
    if (!playlistId) return;
    currentOpenPlaylistId = playlistId;

    // Persist last opened playlist so it can restore on reload
    localStorage.setItem('lastOpenPlaylistId', playlistId);

    switchView('playlist-detail-container', null);
    resetActiveButtons();

    const cover    = document.getElementById('playlist-detail-cover');
    const nameEl   = document.getElementById('playlist-detail-name');
    const countEl  = document.getElementById('playlist-detail-count');
    const trackList= document.getElementById('playlist-detail-tracklist');

    if (nameEl)  nameEl.textContent  = 'Loading...';
    if (trackList) trackList.innerHTML = '';

    const playlist = await spotifyFetch(`https://api.spotify.com/v1/playlists/${playlistId}`);
    if (!playlist) {
        if (nameEl) nameEl.textContent = 'Could not load playlist';
        return;
    }

    if (nameEl)  nameEl.textContent  = playlist.name;
    if (countEl) countEl.textContent = `${playlist.tracks?.total || 0} songs`;
    if (cover && playlist.images?.[0]?.url) {
        cover.style.backgroundImage = `url('${playlist.images[0].url}')`;
    }

    renderPlaylistTracks(playlist.tracks?.items || []);
}

function renderPlaylistTracks(items) {
    const trackList = document.getElementById('playlist-detail-tracklist');
    if (!trackList) return;

    const validItems = items.filter(i => i.track); // Spotify can return null tracks (removed/local files)
    const trackObjects = validItems.map(i => i.track); // flat list for queueing

    if (!validItems.length) {
        trackList.innerHTML = '<p class="playlist-empty-state">No songs yet — add some from search!</p>';
        return;
    }

    trackList.innerHTML = '';
    validItems.forEach(({ track }) => {
        const img = track.album?.images?.[0]?.url || '';
        const row = document.createElement('div');
        row.className = 'playlist-track-row';
        row.innerHTML = `
            <img src="${img}" alt="${track.name}">
            <div class="playlist-track-info">
                <span>${track.name}</span>
                <span>${track.artists?.map(a => a.name).join(', ') || ''}</span>
            </div>
            <span class="playlist-track-duration">${formatTime(track.duration_ms)}</span>
        `;
        // Playing from a playlist queues the rest of the playlist after it
        row.addEventListener('click', () => playTrackAndQueue(track, trackObjects));
        trackList.appendChild(row);
    });
}

// Library button toggle inside navMap — clicking Browse while not in library shows categories;
// Create Playlist always switches to library mode + opens the modal
document.getElementById('btn-browse-sidebar')?.addEventListener('click', () => {
    if (libraryMode) renderBrowseCategories();
});

// Override: when Create Playlist clicked, also switch view to Browse (library) container
document.getElementById('btn-create-playlist')?.addEventListener('click', () => {
    switchView('browse-menu-display-container', 'btn-browse-sidebar');
    resetActiveButtons();
    document.getElementById('btn-browse-sidebar')?.classList.add('active');
    renderLibrary();
});

// ---------- EXPAND / COLLAPSE FOR EVERY PAGE ----------

document.querySelectorAll('.page-expand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        const target   = document.getElementById(targetId);
        if (!target) return;

        const isExpanded = target.classList.toggle('is-expanded');
        btn.innerHTML = isExpanded
            ? '<i class="fa-solid fa-compress"></i>'
            : '<i class="fa-solid fa-expand"></i>';
    });
});

// ---------- RESTORE LAST OPEN PLAYLIST ----------

window.addEventListener('DOMContentLoaded', () => {
    const savedView = localStorage.getItem('lastView');
    if (savedView === 'playlist-detail-container') {
        const lastPlaylistId = localStorage.getItem('lastOpenPlaylistId');
        if (lastPlaylistId) openPlaylistDetail(lastPlaylistId);
    } else if (savedView === 'browse-menu-display-container' && localStorage.getItem('lastBrowseMode') === 'library') {
        renderLibrary(true);
    }
});

// ==============================================
// STAGE 2: QUEUE, SHUFFLE, REPEAT, AUTO-ADVANCE
// ==============================================

// Internal queue — the app's own source of truth for "what plays next".
// Spotify's Web Playback SDK does not auto-advance after a single playTrack()
// call unless we explicitly hand it a queue via the /me/player/queue endpoint,
// so we track it ourselves and drive playback forward manually on track end.
let internalQueue   = [];   // array of track objects, in upcoming order
let shuffleEnabled  = false;
let repeatMode      = 'off'; // 'off' | 'context' (repeat all / loop queue) | 'track' (repeat one)

// ---------- QUEUE HELPERS ----------

// Adds a single track to the end of the internal queue, and mirrors it to
// Spotify's own queue so external clients (phone app etc.) also see it.
async function addToQueue(track) {
    if (!track?.uri) return;
    internalQueue.push(track);
    saveQueueState();
    refreshQueueModalIfOpen();

    const token = await getValidToken();
    if (!token || !currentDeviceId) return;
    try {
        await fetch(`https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(track.uri)}&device_id=${currentDeviceId}`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token }
        });
    } catch (err) {
        console.warn('⚠️ Could not mirror queue to Spotify:', err);
    }
}

// Removes a track from a specific position in the internal queue
function removeFromQueue(index) {
    internalQueue.splice(index, 1);
    saveQueueState();
    refreshQueueModalIfOpen();
}

// Plays a track immediately and loads the remaining tracks from its source list
// (playlist / search results / recently played / top tracks) into the queue,
// so "play" from any list behaves like a real playlist rather than a one-shot.
async function playTrackAndQueue(track, fullList = []) {
    if (!track?.uri) return;

    // Reset queue to whatever comes after this track in its source list
    const startIndex = fullList.findIndex(t => (t.uri || t.track?.uri) === track.uri);
    const rest = startIndex >= 0
        ? fullList.slice(startIndex + 1).map(t => t.track || t) // playlist items are wrapped in { track }
        : [];

    internalQueue = shuffleEnabled ? shuffleArray(rest) : rest;
    saveQueueState();
    refreshQueueModalIfOpen();

    await playTrack(track.uri);
}

function shuffleArray(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function saveQueueState() {
    try { localStorage.setItem('internalQueue', JSON.stringify(internalQueue)); }
    catch (e) { /* storage full, non-critical */ }
}

function restoreQueueState() {
    try {
        const saved = localStorage.getItem('internalQueue');
        if (saved) internalQueue = JSON.parse(saved);
    } catch (e) { internalQueue = []; }
}

// ---------- TRACK END HANDLING (fixes the dead-stop bug) ----------

async function handleTrackEnded() {
    console.log('🏁 Track ended naturally');

    // Repeat-one: replay the exact same track
    if (repeatMode === 'track' && currentTrack) {
        playTrack(currentTrack.uri);
        return;
    }

    // Pull the next track from our internal queue
    if (internalQueue.length > 0) {
        const next = internalQueue.shift();
        saveQueueState();
        refreshQueueModalIfOpen();
        playTrack(next.uri);
        return;
    }

    // Repeat-context with an empty queue but we still remember the track that
    // just finished — nothing further to loop to without the original list,
    // so we simply stop. (Acceptable scope for this stage — full context replay
    // would require caching the whole source list separately.)
    console.log('📭 Queue empty — playback stopped');
    isPlaying = false;
    updateAllPlayButtons();
    stopProgressPolling();
}

// ---------- SHUFFLE ----------

const shuffleBtn = document.getElementById('shuffle-btn-now-playing');

function updateShuffleUI() {
    shuffleBtn?.classList.toggle('is-active', shuffleEnabled);
}

shuffleBtn?.addEventListener('click', async () => {
    shuffleEnabled = !shuffleEnabled;
    localStorage.setItem('shuffleEnabled', shuffleEnabled);
    updateShuffleUI();

    // Shuffle the current queue immediately so it takes effect right away
    if (shuffleEnabled) internalQueue = shuffleArray(internalQueue);
    saveQueueState();
    refreshQueueModalIfOpen();

    if (!currentDeviceId) return;
    const token = await getValidToken();
    if (!token) return;
    try {
        await fetch(`https://api.spotify.com/v1/me/player/shuffle?state=${shuffleEnabled}&device_id=${currentDeviceId}`, {
            method: 'PUT',
            headers: { 'Authorization': 'Bearer ' + token }
        });
    } catch (err) { console.warn('⚠️ Shuffle toggle failed:', err); }
});

// ---------- REPEAT ----------

const repeatBtn = document.getElementById('repeat-btn-now-playing');
const repeatCycle = ['off', 'context', 'track'];

function updateRepeatUI() {
    if (!repeatBtn) return;
    repeatBtn.classList.toggle('is-active',    repeatMode !== 'off');
    repeatBtn.classList.toggle('is-repeat-one', repeatMode === 'track');
}

repeatBtn?.addEventListener('click', async () => {
    const currentIndex = repeatCycle.indexOf(repeatMode);
    repeatMode = repeatCycle[(currentIndex + 1) % repeatCycle.length];
    localStorage.setItem('repeatMode', repeatMode);
    updateRepeatUI();

    if (!currentDeviceId) return;
    const token = await getValidToken();
    if (!token) return;
    try {
        await fetch(`https://api.spotify.com/v1/me/player/repeat?state=${repeatMode}&device_id=${currentDeviceId}`, {
            method: 'PUT',
            headers: { 'Authorization': 'Bearer ' + token }
        });
    } catch (err) { console.warn('⚠️ Repeat toggle failed:', err); }
});

// ---------- QUEUE MODAL ----------

const queueModal       = document.getElementById('queue-modal');
const queueNowPlaying  = document.getElementById('queue-now-playing-row');
const queueNextList    = document.getElementById('queue-next-list');

function openQueueModal() {
    queueModal?.classList.remove('is-hidden');
    renderQueueModal();
}

function closeQueueModal() {
    queueModal?.classList.add('is-hidden');
}

function renderQueueModal() {
    if (!queueModal || queueModal.classList.contains('is-hidden')) return;

    // Now playing row
    if (queueNowPlaying) {
        if (currentTrack) {
            const img = currentTrack.album?.images?.[0]?.url || '';
            queueNowPlaying.innerHTML = `
                <div class="queue-track-row">
                    <img src="${img}" alt="${currentTrack.name}">
                    <div class="queue-track-info">
                        <span>${currentTrack.name}</span>
                        <span>${currentTrack.artists?.[0]?.name || ''}</span>
                    </div>
                </div>
            `;
        } else {
            queueNowPlaying.innerHTML = '<p class="queue-empty-state">Nothing playing</p>';
        }
    }

    // Up next list
    if (queueNextList) {
        if (!internalQueue.length) {
            queueNextList.innerHTML = '<p class="queue-empty-state">Queue is empty — add songs from search or a playlist</p>';
            return;
        }
        queueNextList.innerHTML = '';
        internalQueue.forEach((track, index) => {
            const img = track.album?.images?.[0]?.url || '';
            const row = document.createElement('div');
            row.className = 'queue-track-row';
            row.innerHTML = `
                <img src="${img}" alt="${track.name}">
                <div class="queue-track-info">
                    <span>${track.name}</span>
                    <span>${track.artists?.[0]?.name || ''}</span>
                </div>
                <span class="queue-track-remove" title="Remove from queue">
                    <i class="fa-solid fa-xmark"></i>
                </span>
            `;
            // Click the row (not the remove button) to jump straight to that track
            row.addEventListener('click', (e) => {
                if (e.target.closest('.queue-track-remove')) return;
                internalQueue.splice(0, index + 1); // drop everything up to and including this track
                saveQueueState();
                playTrack(track.uri);
                renderQueueModal();
            });
            row.querySelector('.queue-track-remove').addEventListener('click', (e) => {
                e.stopPropagation();
                removeFromQueue(index);
            });
            queueNextList.appendChild(row);
        });
    }
}

// Re-renders the queue modal only if it's currently open, called after any queue mutation
function refreshQueueModalIfOpen() {
    if (queueModal && !queueModal.classList.contains('is-hidden')) renderQueueModal();
}

document.getElementById('queue-btn-now-playing')?.addEventListener('click', openQueueModal);
document.getElementById('queue-modal-close')?.addEventListener('click', closeQueueModal);
queueModal?.addEventListener('click', (e) => { if (e.target === queueModal) closeQueueModal(); });

// ---------- WIRE "ADD TO PLAYLIST" PLUS BUTTON NEXT TO NOW-PLAYING IMAGE ----------
// (Stage 1 only wired the right-panel save button — this one sits beside the
// big now-playing artwork on the dedicated Now Playing page)

document.getElementById('add-to-playlist-now-playing-btn')?.addEventListener('click', () => {
    if (currentTrackUri) openAddToPlaylistModal(currentTrackUri);
    else showNotification('No track currently playing');
});

// ---------- RESTORE SHUFFLE / REPEAT / QUEUE ON LOAD ----------

window.addEventListener('DOMContentLoaded', () => {
    shuffleEnabled = localStorage.getItem('shuffleEnabled') === 'true';
    repeatMode     = localStorage.getItem('repeatMode') || 'off';
    updateShuffleUI();
    updateRepeatUI();
    restoreQueueState();
});