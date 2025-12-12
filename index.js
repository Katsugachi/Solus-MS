// Static List of games that came with the launcher (non-IndexedDB)
const staticGames = [
    { name: "Hollow Knight", cover: "Imgs/hk.jpg", url: "games/StrHK.html" },
    { name: "Slope", cover: "Imgs/slope.jpg", url: "games/Slope.html" },
    { name: "Minecraft 1.12.2", cover: "Imgs/minecraft.jpg", url: "games/mc1122.html" },
    { name: "Sans Bad Time Simulator", cover: "Imgs/undertale.png", url: "games/sansfight.html" },
    { name: "Undertale Yellow", cover: "Imgs/uy.png", url: "games/undertaley.html" },
    { name: "Geometry Dash Lite", cover: "Imgs/gd.png", url: "games/gd.html" },
    { name: "Sheepy : A Short Adventure", cover: "Imgs/sheepy.png", url: "games/sheepy.html" },
    { name: "OSU!", cover: "Imgs/osu.png", url: "games/osu.html" },
    { name: "Level Devil", cover: "Imgs/leveldevil.png", url: "games/leveldevil.html" },
    { name: "Run 3", cover: "Imgs/run-3.png", url: "games/run3.html" },
    { name: "Balatro", cover: "Imgs/balatro.jpg", url: "games/balatro.html" },
    { name: "Fire And Ice", cover: "Imgs/FandI.jpeg", url: "games/FireAndIce.html" },
    { name: "Drivemad", cover: "Imgs/DriveM.jpeg", url: "games/DriveMad.html" },
    { name: "Plants VS Zombies", cover: "Imgs/PVZ.jpeg", url: "games/PvZ.html" },
    { name: "Shapez", cover: "Imgs/Shapez.jpeg", url: "games/Shapez.html" },
    { name: "Minesweeper+", cover: "Imgs/MSPlus.png", url: "games/MinesweeperPlus/MinesweeperPlus.html" },
];

// ===========================================
// 0. INDEXEDDB SETUP AND UTILITIES
// ===========================================
let db;
const DB_NAME = 'SolusGamesDB';
const STORE_NAME = 'customGames';

// Initialize IndexedDB
function initDB() {
    return new Promise((resolve, reject) => {
        // Check for IndexedDB support
        if (!window.indexedDB) {
            console.warn("IndexedDB not supported. Custom game feature disabled.");
            reject('IndexedDB not supported.');
            return;
        }

        const request = indexedDB.open(DB_NAME, 1);

        request.onerror = (event) => {
            console.error("IndexedDB error:", event.target.errorCode);
            reject('Failed to open IndexedDB.');
        };

        request.onupgradeneeded = (event) => {
            db = event.target.result;
            const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            objectStore.createIndex('name', 'name', { unique: false });
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log("IndexedDB initialized successfully.");
            resolve(db);
        };
    });
}

// Save a new game object to IndexedDB
function saveGame(game) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.add(game);

        request.onsuccess = () => {
            resolve(request.result); // The ID of the newly added game
        };

        request.onerror = (event) => {
            console.error("Error saving game:", event.target.error);
            reject(event.target.error);
        };
    });
}

// Get all saved games from IndexedDB
function getAllGames() {
    return new Promise((resolve, reject) => {
        if (!db) return resolve([]); // Return empty array if DB isn't ready
        
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => {
            resolve(request.result);
        };

        request.onerror = (event) => {
            console.error("Error fetching games:", event.target.error);
            reject(event.target.error);
        };
    });
}

// Delete a game by its ID
function deleteGame(gameId) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(gameId);

        request.onsuccess = () => {
            resolve();
        };

        request.onerror = (event) => {
            console.error("Error deleting game:", event.target.error);
            reject(event.target.error);
        };
    });
}

// ===========================================
// 1. DYNAMIC GAME RENDERING
// ===========================================

const gameLibraryGrid = document.getElementById('game-library-grid');
const emptyMessage = document.getElementById('empty-library-message');

// This function creates the card HTML element for a game
function createGameCard(game, isCustom = false) {
    const card = document.createElement('div');
    card.className = 'game-card';

    const coverStyle = game.cover ? `background-image: url('${game.cover}');` : '';
    
    let launchUrl;
    if (isCustom) {
        // Create a secure blob URL for the HTML content
        const blob = new Blob([game.htmlContent], { type: 'text/html' });
        launchUrl = URL.createObjectURL(blob);
    } else {
        // Static games launch their pre-existing file
        launchUrl = game.url;
    }

    card.innerHTML = `
        <div class="game-image-placeholder" style="${coverStyle}">
            ${game.cover ? '' : game.name}
        </div>
        <div class="game-info">
            <h3>${game.name}</h3>
            <div class="action-group">
                <a href="${launchUrl}" class="launch-btn" target="_blank">Launch</a>
                ${isCustom ? `<button class="launch-btn delete-btn" data-game-id="${game.id}" style="flex-grow: 0.5;">Delete</button>` : ''}
            </div>
        </div>
    `;
    
    // Add the delete event listener for custom games
    if (isCustom) {
        card.querySelector('.delete-btn').addEventListener('click', async (e) => {
            const gameId = parseInt(e.target.dataset.gameId);
            if (confirm(`Are you sure you want to delete the custom game: ${game.name}?`)) {
                try {
                    await deleteGame(gameId);
                    loadGames(); // Reload the library
                } catch (error) {
                    alert('Failed to delete game.');
                }
            }
        });
    }

    return card;
}

// Main function to load and display all games (static + custom)
async function loadGames() {
    gameLibraryGrid.innerHTML = '';
    
    // 1. Load Static Games
    staticGames.forEach(game => {
        gameLibraryGrid.appendChild(createGameCard(game, false));
    });
    
    // 2. Load Custom Games from IndexedDB
    let customGames = [];
    try {
        customGames = await getAllGames();
        customGames.forEach(game => {
            gameLibraryGrid.appendChild(createGameCard(game, true));
        });
    } catch (e) {
        console.error("Could not load custom games:", e);
    }

    // Show/hide empty message
    if (staticGames.length === 0 && customGames.length === 0) {
        emptyMessage.classList.remove('hidden');
    } else {
        emptyMessage.classList.add('hidden');
    }
}

// ===========================================
// 2. PAGE & THEME SWITCHING 
// ===========================================

const navLibrary = document.getElementById('nav-library');
const navSettings = document.getElementById('nav-settings');
const navAbout = document.getElementById('nav-about');
const navAddGame = document.getElementById('nav-add-game');

const libraryPage = document.getElementById('library-page');
const settingsPage = document.getElementById('settings-page');
const aboutPage = document.getElementById('about-page');
const addGamePage = document.getElementById('add-game-page');

const themeToggle = document.getElementById('theme-toggle');
const body = document.body;
const mainHeader = document.querySelector('.header h2');

function showPage(pageId) {
    // Hide all pages
    libraryPage.style.display = 'none';
    settingsPage.style.display = 'none';
    aboutPage.style.display = 'none';
    addGamePage.style.display = 'none';

    // Remove active class from all nav items
    navLibrary.classList.remove('active');
    navSettings.classList.remove('active');
    navAbout.classList.remove('active');
    navAddGame.classList.remove('active');

    // Show the requested page and set the active link and header
    let targetPage;
    let targetNav;
    let headerText;

    switch (pageId) {
        case 'library':
            targetPage = libraryPage;
            targetNav = navLibrary;
            headerText = 'Game Library';
            loadGames(); // Reload games whenever library is shown
            break;
        case 'settings':
            targetPage = settingsPage;
            targetNav = navSettings;
            headerText = 'Application Settings';
            break;
        case 'about':
            targetPage = aboutPage;
            targetNav = navAbout;
            headerText = 'About Solus MS';
            break;
        case 'add-game': 
            targetPage = addGamePage;
            targetNav = navAddGame;
            headerText = 'Add New Game';
            break;
        default:
            return;
    }

    targetPage.style.display = 'block';
    targetNav.classList.add('active');
    mainHeader.textContent = headerText;
}

// Attach event listeners for navigation
navLibrary.addEventListener('click', (e) => {
    e.preventDefault();
    showPage('library');
});

navSettings.addEventListener('click', (e) => {
    e.preventDefault();
    showPage('settings');
});

navAbout.addEventListener('click', (e) => {
    e.preventDefault();
    showPage('about');
});

navAddGame.addEventListener('click', (e) => {
    e.preventDefault();
    showPage('add-game');
});

// Theme Switching Logic (Dark/Light)
themeToggle.addEventListener('change', function() {
    if (this.checked) {
        body.classList.remove('light-theme');
    } else {
        body.classList.add('light-theme');
    }
});

// ===========================================
// 3. ADD GAME FORM LOGIC
// ===========================================
const addGameForm = document.getElementById('add-game-form');
const gameNameInput = document.getElementById('game-name');
const coverUrlInput = document.getElementById('cover-url');
const coverFileInput = document.getElementById('cover-file');
const htmlCodeInput = document.getElementById('html-code');
const htmlFileInput = document.getElementById('html-file');
const statusMessage = document.getElementById('game-status-message');

const imageUrlGroup = document.getElementById('image-url-group');
const imageFileGroup = document.getElementById('image-file-group');
const htmlPasteGroup = document.getElementById('html-paste-group');
const htmlFileGroup = document.getElementById('html-file-group');

// Helper function to toggle form visibility based on selected radio
function setupFormOptions(name, optionGroups) {
    document.querySelectorAll(`input[name="${name}"]`).forEach(radio => {
        radio.closest('.upload-option').addEventListener('click', () => {
            // Update active class on visual options
            document.querySelectorAll(`.upload-option[data-option^="${name.split('-')[0]}"]`).forEach(opt => {
                opt.classList.remove('active-option');
            });
            radio.closest('.upload-option').classList.add('active-option');
            radio.checked = true; // Ensure the radio button is checked
            
            // Toggle visibility of related input groups
            for (const [key, element] of Object.entries(optionGroups)) {
                if (key.includes(radio.value)) {
                    element.classList.remove('hidden');
                } else {
                    element.classList.add('hidden');
                }
            }
            
            // Clear the state of the non-selected input when switching
            if (name === 'cover-source') {
                if (radio.value === 'url') {
                    coverFileInput.value = '';
                } else {
                    coverUrlInput.value = '';
                }
            } else if (name === 'html-source') {
                if (radio.value === 'paste') {
                    htmlFileInput.value = '';
                } else {
                    htmlCodeInput.value = '';
                }
            }
        });
    });
}

// Setup for Cover Art Options
setupFormOptions('cover-source', {
    'url': imageUrlGroup,
    'file': imageFileGroup
});

// Setup for HTML Content Options
setupFormOptions('html-source', {
    'paste': htmlPasteGroup,
    'file': htmlFileGroup
});

// Helper to read file as a data URL (for images)
function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = (error) => reject(error);
        reader.readAsDataURL(file);
    });
}

// Helper to read file as text (for HTML)
function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = (error) => reject(error);
        reader.readAsText(file);
    });
}

// Handle Form Submission
addGameForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    statusMessage.textContent = 'Saving game...';
    statusMessage.style.color = '#007bff';

    const name = gameNameInput.value.trim();
    if (!name) {
        statusMessage.textContent = 'Please enter a game name.';
        statusMessage.style.color = '#dc3545';
        return;
    }
    
    let coverData = '';
    const coverSource = document.querySelector('input[name="cover-source"]:checked').value;

    try {
        // 1. Get Cover Art Data
        if (coverSource === 'url') {
            coverData = coverUrlInput.value.trim();
        } else if (coverSource === 'file' && coverFileInput.files.length > 0) {
            // Check image file type
            if (!coverFileInput.files[0].type.startsWith('image/')) {
                statusMessage.textContent = 'Uploaded file is not a valid image.';
                statusMessage.style.color = '#dc3545';
                return;
            }
            coverData = await readFileAsDataURL(coverFileInput.files[0]);
        }
        
        // 2. Get HTML Content
        let htmlContent = '';
        const htmlSource = document.querySelector('input[name="html-source"]:checked').value;

        if (htmlSource === 'paste') {
            htmlContent = htmlCodeInput.value.trim();
        } else if (htmlSource === 'file' && htmlFileInput.files.length > 0) {
            // Ensure it's an HTML file
            if (!htmlFileInput.files[0].name.toLowerCase().endsWith('.html') && !htmlFileInput.files[0].name.toLowerCase().endsWith('.htm')) {
                statusMessage.textContent = 'Uploaded file must be an .html or .htm file.';
                statusMessage.style.color = '#dc3545';
                return;
            }
            htmlContent = await readFileAsText(htmlFileInput.files[0]);
        }

        if (!htmlContent) {
            statusMessage.textContent = 'HTML content is required.';
            statusMessage.style.color = '#dc3545';
            return;
        }
        
        // 3. Create Game Object and Save
        const newGame = {
            name: name,
            cover: coverData, // This will be a URL or a DataURL string
            htmlContent: htmlContent,
            timestamp: Date.now()
        };

        await saveGame(newGame);

        // 4. Success, Cleanup, and Switch Page
        statusMessage.textContent = `Game "${name}" successfully added! Switching to Library...`;
        statusMessage.style.color = '#28a745';
        
        // Clear all form fields
        addGameForm.reset(); 
        
        // Delay the page switch to show the confirmation message briefly
        setTimeout(() => {
            showPage('library');
        }, 1000); 

    } catch (error) {
        console.error("Game saving failed:", error);
        statusMessage.textContent = `Failed to add game. Error: ${error.message || 'IndexedDB failed or file reading error.'}`;
        statusMessage.style.color = '#dc3545';
    }
});


// ===========================================
// 4. INITIALIZATION
// ===========================================

// Run this function when the script starts
(async function initialize() {
    try {
        // 1. Initialize DB
        await initDB();
        
        // 2. Load the default page (Library) and all games
        showPage('library'); 
    } catch (error) {
        // If initialization fails, fall back to showing the library without custom games
        console.error("Initialization failed:", error);
        showPage('library');
    }
})();

