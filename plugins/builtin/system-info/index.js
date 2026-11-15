'use strict';

const os = require('os');

module.exports = {
  activate(ctx) {
    ctx.registerTool({
      name: 'system_info',
      description: '读取本机操作系统、CPU、内存、网络与运行时长信息。',
      parameters: { type: 'object', properties: {} },
      async run() {
        const nets = os.networkInterfaces();
        const addresses = [];
        for (const [name, list] of Object.entries(nets)) {
          for (const item of list || []) {
            if (!item.internal && item.family === 'IPv4') addresses.push(`${name}: ${item.address}`);
          }
        }
        return {
          platform: `${os.platform()} ${os.release()}`,
          arch: os.arch(),
          hostname: os.hostname(),
          cpu: os.cpus()[0]?.model,
          cores: os.cpus().length,
          memory: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB（可用 ${Math.round(os.freemem() / 1024 / 1024 / 1024)} GB）`,
          uptime: `${Math.round(os.uptime() / 3600)} 小时`,
          addresses,
        };
      },
    });
  },
};
