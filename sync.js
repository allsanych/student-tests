const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { io: ioClient } = require('socket.io-client');

module.exports = function setupSync(serverHostIo, onSyncUpdate) {
    const SYNC_SECRET = process.env.SYNC_SECRET || 'sync_secret_1234';
    const SYNC_MASTER_URL = process.env.SYNC_MASTER_URL;
    const TESTS_DIR = path.join(__dirname, 'tests');
    const RESULTS_DIR = path.join(__dirname, 'results');

    if (!fs.existsSync(TESTS_DIR)) fs.mkdirSync(TESTS_DIR, { recursive: true });
    if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

    function getRelativePath(absolutePath) {
        if (absolutePath.startsWith(TESTS_DIR)) return 'tests/' + path.relative(TESTS_DIR, absolutePath).replace(/\\/g, '/');
        if (absolutePath.startsWith(RESULTS_DIR)) return 'results/' + path.relative(RESULTS_DIR, absolutePath).replace(/\\/g, '/');
        if (absolutePath.endsWith('active_sessions.json')) return 'active_sessions.json';
        return null;
    }

    function getAllFiles(dir, fileList = []) {
        if (!fs.existsSync(dir)) return fileList;
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            const filepath = path.join(dir, file);
            if (fs.statSync(filepath).isDirectory()) {
                getAllFiles(filepath, fileList);
            } else {
                fileList.push(filepath);
            }
        });
        return fileList;
    }

    function applyRemoteUpdate(data) {
        const fullPath = path.join(__dirname, data.path);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        if (fs.existsSync(fullPath)) {
            const existing = fs.readFileSync(fullPath, 'utf8');
            if (existing === data.content) return; // ignore identical content
        }
        
        fs.writeFileSync(fullPath, data.content, 'utf8');
        console.log(`[SYNC] Updated file from remote: ${data.path}`);
        
        if (onSyncUpdate && data.path === 'active_sessions.json') {
            console.log('[SYNC] Triggering reload for active sessions...');
            onSyncUpdate(data.path);
        }
    }

    function applyRemoteDelete(data) {
        const fullPath = path.join(__dirname, data.path);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            console.log(`[SYNC] Deleted file from remote: ${data.path}`);
        }
        
        // Also cleanup empty directory
        const dir = path.dirname(fullPath);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
            try { fs.rmdirSync(dir); } catch (e) {}
        }
    }

    function handleLocalUpdate(p, emitFn) {
        const relPath = getRelativePath(p);
        if (!relPath) return;
        try {
            const content = fs.readFileSync(p, 'utf8');
            emitFn('file_update', { path: relPath, content, time: Date.now() });
        } catch (e) {
            console.error('[SYNC] Read error:', e.message);
        }
    }

    function handleLocalDelete(p, emitFn) {
        const relPath = getRelativePath(p);
        if (!relPath) return;
        emitFn('file_delete', { path: relPath, time: Date.now() });
    }

    if (SYNC_MASTER_URL) {
        console.log(`[SYNC] Running as Client. Connecting to Master at ${SYNC_MASTER_URL}...`);
        const client = ioClient(SYNC_MASTER_URL + '/sync', {
            auth: { token: SYNC_SECRET },
            reconnectionDelayMax: 10000
        });

        client.on('connect', () => {
            console.log(`[SYNC] Connected to Master! Pushing all local files...`);
            const allFiles = [...getAllFiles(TESTS_DIR), ...getAllFiles(RESULTS_DIR)];
            allFiles.forEach(f => {
                const relPath = getRelativePath(f);
                if (relPath) {
                    try {
                       const content = fs.readFileSync(f, 'utf8');
                       client.emit('file_update', { path: relPath, content, time: Date.now() });
                    } catch (e){}
                }
            });
        });

        client.on('file_update', applyRemoteUpdate);
        client.on('file_delete', applyRemoteDelete);
        client.on('disconnect', () => console.log('[SYNC] Disconnected from Master'));

        const watcher = chokidar.watch(['server.js', 'sync.js', 'shared.css', 'active_sessions.json', 'teacher', 'student', 'tests', 'results'], { 
            ignored: [/node_modules/, /\.git/],
            ignoreInitial: true, 
            persistent: true, 
            usePolling: true,
            interval: 1000,
            awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 } 
        });
        watcher.on('add', (p) => { console.log(`[SYNC-DEBUG] Local file ADD: ${p}`); handleLocalUpdate(p, client.emit.bind(client)); });
        watcher.on('change', (p) => { console.log(`[SYNC-DEBUG] Local file CHANGE: ${p}`); handleLocalUpdate(p, client.emit.bind(client)); });
        watcher.on('unlink', (p) => { console.log(`[SYNC-DEBUG] Local file UNLINK: ${p}`); handleLocalDelete(p, client.emit.bind(client)); });
    } 
    else {
        console.log(`[SYNC] Running as Master Server. Listening on /sync namespace.`);
        const syncNamespace = serverHostIo.of('/sync');
        
        syncNamespace.use((socket, next) => {
            if (socket.handshake.auth.token === SYNC_SECRET) next();
            else next(new Error("Invalid sync secret"));
        });
 
        function broadcast(event, payload) {
            syncNamespace.emit(event, payload);
        }
 
        const watcher = chokidar.watch(['server.js', 'sync.js', 'shared.css', 'active_sessions.json', 'teacher', 'student', 'tests', 'results'], { 
            ignored: [/node_modules/, /\.git/],
            ignoreInitial: true, 
            persistent: true,
            awaitWriteFinish: { stabilityThreshold: 500 } 
        });
        watcher.on('add', (p) => handleLocalUpdate(p, broadcast));
        watcher.on('change', (p) => handleLocalUpdate(p, broadcast));
        watcher.on('unlink', (p) => handleLocalDelete(p, broadcast));

        syncNamespace.on('connection', (socket) => {
            console.log(`[SYNC] New sync client connected: ${socket.id}`);
            
            socket.on('file_update', (data) => {
                applyRemoteUpdate(data);
                socket.broadcast.emit('file_update', data); 
            });

            socket.on('file_delete', (data) => {
                applyRemoteDelete(data);
                socket.broadcast.emit('file_delete', data);
            });
            
            socket.on('disconnect', () => console.log(`[SYNC] Sync client disconnected: ${socket.id}`));
        });
    }
};
