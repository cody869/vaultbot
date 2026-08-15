// fantasyDeployCommands.js — the /fantasy command definition.
// In deploy-commands.js:  import { fantasyCommand } from './fantasyDeployCommands.js';
// then spread it into the commands array:  ...fantasyCommand,

import { SlashCommandBuilder } from 'discord.js';

export const fantasyCommand = [
  new SlashCommandBuilder()
    .setName('fantasy')
    .setDescription('XCFL best ball fantasy league')

    .addSubcommand((s) => s
      .setName('setup')
      .setDescription('Create the league (commissioner only)'))

    .addSubcommand((s) => s
      .setName('join')
      .setDescription('Claim one of the 12 spots')
      .addStringOption((o) => o
        .setName('team_name')
        .setDescription('Your fantasy team name')
        .setRequired(false)))

    .addSubcommand((s) => s
      .setName('leave')
      .setDescription('Give up your spot (before the draft only)'))

    .addSubcommand((s) => s
      .setName('start')
      .setDescription('Randomize the order and open the draft (commissioner only)'))

    .addSubcommand((s) => s
      .setName('order')
      .setDescription('Show the draft order and who is on the clock'))

    .addSubcommand((s) => s
      .setName('pick')
      .setDescription('Make your pick')
      .addStringOption((o) => o
        .setName('player')
        .setDescription('Search for a player or team defense')
        .setRequired(true)
        .setAutocomplete(true)))

    .addSubcommand((s) => s
      .setName('queue')
      .setDescription('View or edit your autopick queue')
      .addStringOption((o) => o
        .setName('add')
        .setDescription('Add a player to the queue')
        .setRequired(false)
        .setAutocomplete(true))
      .addBooleanOption((o) => o
        .setName('clear')
        .setDescription('Empty the queue')
        .setRequired(false)))

    .addSubcommand((s) => s
      .setName('board')
      .setDescription('Draft board')
      .addIntegerOption((o) => o
        .setName('round')
        .setDescription('Show a specific round')
        .setMinValue(1)
        .setMaxValue(12)
        .setRequired(false)))

    .addSubcommand((s) => s
      .setName('team')
      .setDescription('View a roster')
      .addUserOption((o) => o
        .setName('user')
        .setDescription('Whose team (defaults to you)')
        .setRequired(false)))

    .addSubcommand((s) => s
      .setName('standings')
      .setDescription('League standings'))

    .addSubcommand((s) => s
      .setName('matchup')
      .setDescription('Weekly matchups')
      .addIntegerOption((o) => o
        .setName('week')
        .setDescription('Week number')
        .setMinValue(1)
        .setMaxValue(18)
        .setRequired(false)))

    .addSubcommand((s) => s
      .setName('scores')
      .setDescription('Your best-ball lineup for a week')
      .addIntegerOption((o) => o
        .setName('week')
        .setDescription('Week number')
        .setMinValue(1)
        .setMaxValue(18)
        .setRequired(false))
      .addUserOption((o) => o
        .setName('user')
        .setDescription('Whose scores (defaults to you)')
        .setRequired(false)))

    .addSubcommand((s) => s
      .setName('score-week')
      .setDescription('Force-score a week (commissioner only)')
      .addIntegerOption((o) => o
        .setName('week')
        .setDescription('Week number')
        .setMinValue(1)
        .setMaxValue(18)
        .setRequired(true))
      .addBooleanOption((o) => o
        .setName('force')
        .setDescription('Score even if games are missing')
        .setRequired(false)))

    .addSubcommand((s) => s
      .setName('doctor')
      .setDescription('Check stat field mapping against live data (commissioner only)')),
];
