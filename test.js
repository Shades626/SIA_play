import { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    signInWithPopup, 
    GoogleAuthProvider, 
    signOut, 
    onAuthStateChanged,
    setPersistence,
    browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

// Initialize auth
const auth = window.auth;
const googleProvider = new GoogleAuthProvider();

// 1. Force Local Persistence (User stays logged in on refresh)
setPersistence(auth, browserLocalPersistence).catch(console.error);

// 2. Navigation Map
const navMap = {
    'btn-home': 'home-menu-display-container',
    'btn-browse': 'browse-menu-display-container',
    'btn-browse-sidebar': 'browse-menu-display-container',
    'btn-nowPlaying-sidebar': 'now-playing-menu-display-container',
};

// --- CORE FUNCTIONS ---

function switchView(viewId, buttonId = null) {
    document.querySelectorAll('.view-content').forEach(view => view.classList.add('is-hidden'));
    const targetView = document.getElementById(viewId);
    if (targetView) {
        targetView.classList.remove('is-hidden');
        localStorage.setItem('lastView', viewId);
        if (buttonId) localStorage.setItem('lastButton', buttonId);
    }
}

function resetActiveButtons() {
    Object.keys(navMap).forEach(id => document.getElementById(id)?.classList.remove('active'));
}

// --- INITIALIZATION ---

window.addEventListener('DOMContentLoaded', () => {
    // A. Setup Navigation
    Object.keys(navMap).forEach(btnId => {
        document.getElementById(btnId)?.addEventListener('click', () => {
            switchView(navMap[btnId], btnId);
            resetActiveButtons();
            document.getElementById(btnId).classList.add('active');
        });
    });

    // B. Setup Theme & Sidebar Toggle
    document.querySelector('.collapse-btn-sidebar')?.addEventListener('click', () => {
        document.getElementById('main')?.classList.toggle('collapsed-style');
        localStorage.setItem('sidebarCollapsed', document.getElementById('main')?.classList.contains('collapsed-style'));
    });

    [document.getElementById('theme-toggle-btn'), document.getElementById('theme-toggle-btn-mobile')].forEach(btn => 
        btn?.addEventListener('click', () => {
            document.body.classList.toggle('light-mode');
            localStorage.setItem('theme', document.body.classList.contains('light-mode') ? 'light' : 'dark');
        })
    );

    // C. Global Click Listener for Auth & Logout (Event Delegation)
    document.addEventListener('click', (e) => {
        if (e.target.id === 'logout-btn') {
        console.log("Logout button clicked! Attempting Firebase signout...");
        
        signOut(auth)
            .then(() => {
                console.log("Signout successful. Reloading page...");
                localStorage.clear();
                window.location.reload();
            })
            .catch((error) => {
                console.error("Signout failed. Error:", error);
                alert("Logout Error: " + error.message);
            });
        }
        // Login/Auth Logic
        if (e.target.id === 'auth-submit-btn') {
            const email = document.getElementById('email')?.value;
            const pass = document.getElementById('password')?.value;
            const isSignUp = document.getElementById('auth-heading')?.innerText === 'Create Account';
            
            if (isSignUp) createUserWithEmailAndPassword(auth, email, pass).catch(err => alert(err.message));
            else signInWithEmailAndPassword(auth, email, pass).catch(err => alert(err.message));
        }
        if (e.target.id === 'google-signin-btn') {
            signInWithPopup(auth, googleProvider).catch(err => alert(err.message));
        }
        if (e.target.id === 'auth-toggle') {
            const isSignUp = document.getElementById('auth-heading').innerText !== 'Create Account';
            document.getElementById('auth-heading').innerText = isSignUp ? 'Create Account' : 'Welcome Back';
            document.getElementById('auth-submit-btn').innerText = isSignUp ? 'Sign Up' : 'Sign In';
            e.target.innerText = isSignUp ? 'Sign In' : 'Sign Up';
        }
    });

    // D. Restore Session
    if (localStorage.getItem('sidebarCollapsed') === 'true') document.getElementById('main')?.classList.add('collapsed-style');
    if (localStorage.getItem('theme') === 'light') document.body.classList.add('light-mode');
    
    const lastView = localStorage.getItem('lastView') || 'home-menu-display-container';
    switchView(lastView);

    // E. Auth State Observer
    onAuthStateChanged(auth, (user) => {
    const authView = document.getElementById("auth-view");
    
    if (user) {
        // User IS logged in
        authView.style.display = "none";
    } else {
        // User IS NOT logged in
        authView.style.display = "flex"; 
        document.querySelectorAll('.view-content').forEach(v => v.classList.add('is-hidden'));
        // CRITICAL: Clear navigation state so they don't see content when they aren't logged in
        localStorage.removeItem('lastView');
        console.log("User logged out, auth view forced.");
    }
});
});