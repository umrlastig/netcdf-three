const path = require('path');

module.exports = {
    mode: 'development',
    entry: {
        "netcdf_three": [path.resolve(__dirname, './src/main.js')],
    },
    devtool: 'source-map',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'netcdf_three.js',
        library: 'netcdf_three',
        libraryTarget: 'umd'
    },
    devServer: {
        devMiddleware: {
            publicPath: '/dist/',
        },
        static: {
            directory: path.resolve(__dirname, './examples')
        },
    },
};
