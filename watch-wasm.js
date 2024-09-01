const chokidar = require('chokidar');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

const rustProjectPath = path.resolve(__dirname, '../minecraft_schematic_utils');
const wasmDestPath = path.resolve(__dirname, 'src/wasm');

// Watch Rust project files
chokidar.watch(path.join(rustProjectPath, 'src'), {
    ignored: /(^|[\/\\])\../,
    persistent: true
}).on('change', (path) => {
    console.log(`File ${path} has been changed. Rebuilding WASM...`);
    rebuildWasm();

});

function rebuildWasm() {
    exec('wasm-pack build --target web', { cwd: rustProjectPath }, (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error}`);
            return;
        }
        console.log(`stdout: ${stdout}`);
        console.error(`stderr: ${stderr}`);

        // Copy WASM files to TypeScript project
        fs.copy(path.join(rustProjectPath, 'pkg'), wasmDestPath, err => {
            if (err) return console.error(err);
            console.log('WASM files copied to TypeScript project');
        });
    });
}

// Initial build
rebuildWasm();