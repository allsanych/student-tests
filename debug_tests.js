const path = require('path');
const fs = require('fs');

function getFiles(dir, baseDir = dir) {
  let results = [];
  try {
    const list = fs.readdirSync(dir, { withFileTypes: true });
    for (const dirent of list) {
      const filePath = path.join(dir, dirent.name);
      const relativePath = path.relative(baseDir, filePath).replace(/\\/g, '/');
      if (dirent.isDirectory()) {
        results.push({ path: relativePath, name: dirent.name, type: 'directory' });
        results = results.concat(getFiles(filePath, baseDir));
      } else if (dirent.name.endsWith('.json')) {
        results.push({
          path: relativePath,
          name: dirent.name,
          type: 'file'
        });
      }
    }
  } catch (e) {
    console.error('Error in getFiles:', e);
  }
  return results;
}

const testsDir = path.join(__dirname, 'tests');
console.log('Tests Dir:', testsDir);
const results = getFiles(testsDir);
console.log('Results Count:', results.length);
console.log('Sample Results:', JSON.stringify(results.slice(0, 5), null, 2));
