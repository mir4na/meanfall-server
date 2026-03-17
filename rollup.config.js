const resolve = require('@rollup/plugin-node-resolve');
const typescript = require('@rollup/plugin-typescript');

module.exports = {
    input: 'src/index.ts',
    output: {
        file: 'dist/index.js',
        format: 'cjs'
    },
    treeshake: false,
    plugins: [
        resolve(),
        typescript()
    ]
};
