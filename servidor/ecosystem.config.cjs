module.exports = {
  apps: [
    {
      name: 'bingoelus-server',
      cwd: __dirname,
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
      },
    },
  ],
};
