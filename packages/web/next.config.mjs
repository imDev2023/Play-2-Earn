/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The public fairness verifier ships as TypeScript source (it's meant to be read,
  // not just run), so Next compiles it alongside the app rather than consuming a build.
  transpilePackages: ["@rushood/verifier"],
  webpack: (config, { webpack }) => {
    // wagmi's connectors barrel transitively pulls optional deps we don't use on web:
    // Coinbase cdp-sdk's @x402/* payment packages, WalletConnect's pino-pretty logger,
    // and MetaMask SDK's React Native async-storage. None are installed; ignore the
    // specifiers so resolution neither fails (@x402) nor warns (the others).
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp:
          /^@x402(\/|$)|^pino-pretty$|^@react-native-async-storage\/async-storage$/,
      }),
    );
    return config;
  },
};

export default nextConfig;
