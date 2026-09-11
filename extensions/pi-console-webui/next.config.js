const { join } = require("node:path");
const appRoot = __dirname;

module.exports = {
  outputFileTracingRoot: join(__dirname, "../.."),
  // npm installs Pi Feats below node_modules. Ask Next to transpile the
  // package itself when the Console app is built from that location.
  transpilePackages: ["pi-feats"],
  webpack(config) {
    config.resolve.alias["@"] = appRoot;
    return config;
  },
};
