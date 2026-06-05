import { Composer, type Context } from 'grammy';
import type { BotOptions } from '../bot.js';
import start from './start.js';
import tz from './tz.js';
import { createStatusCommand } from './status.js';
import id from './id.js';
import help from './help.js';
import whoami from './whoami.js';
import login from './login.js';

export function createCommands(options?: BotOptions): Composer<Context> {
  const commands = new Composer<Context>();
  commands.use(start);
  commands.use(tz);
  commands.use(createStatusCommand(options));
  commands.use(id);
  commands.use(help);
  commands.use(whoami);
  commands.use(login);
  return commands;
}
