// openapi-typescript drives the TypeScript 5 compiler API, which the native TypeScript 7 package of
// @backlog/web does not expose. Give it its own TypeScript 5 instead of the workspace's peer.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === 'openapi-typescript') {
        delete pkg.peerDependencies;
        pkg.dependencies = { ...pkg.dependencies, typescript: 'npm:typescript@5.9.3' };
      }
      return pkg;
    },
  },
};
