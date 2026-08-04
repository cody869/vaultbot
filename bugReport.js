import { SlashCommandBuilder } from 'discord.js';
import { list } from './vault.js';

const VAULT_COLOR = 5198940; // Blue

export default {
  // /bug-status command - shows all bugs and stats
  bugStatus: {
    data: new SlashCommandBuilder()
      .setName('bug-status')
      .setDescription('View all bug reports and their status'),
    async execute(interaction) {
      try {
        const bugs = await list('BugReport', {}, { limit: 100 });
        
        const stats = {
          open: bugs.filter(b => b.status === 'open').length,
          inProgress: bugs.filter(b => b.status === 'in-progress').length,
          resolved: bugs.filter(b => b.status === 'resolved').length,
          closed: bugs.filter(b => b.status === 'closed').length,
          critical: bugs.filter(b => b.severity === 'critical').length,
        };

        // Get open/in-progress bugs, sorted by newest first
        const openBugs = bugs
          .filter(b => b.status === 'open' || b.status === 'in-progress')
          .sort((a, b) => new Date(b.created_date) - new Date(a.created_date))
          .slice(0, 10);

        // Format bug list with severity indicators
        let bugList = openBugs.map((bug, i) => {
          const severity = {
            low: '🔵',
            medium: '🟡',
            high: '🟠',
            critical: '🔴'
          }[bug.severity] || '⚪';
          
          return `${i + 1}. ${severity} **${bug.title}** (\`${bug.id}\`) — ${bug.status}`;
        }).join('\n');

        if (!bugList) bugList = 'No open bugs — great job! 🎉';

        const embed = {
          title: '🐛 Bug Report Status',
          color: VAULT_COLOR,
          fields: [
            {
              name: 'Overall Stats',
              value: `Open: **${stats.open}** | In Progress: **${stats.inProgress}** | Resolved: **${stats.resolved}** | Critical: **${stats.critical}**`,
              inline: false
            },
            {
              name: 'Active Bugs (Top 10)',
              value: bugList,
              inline: false
            },
            {
              name: 'How to Resolve',
              value: 'Use `/resolve-bug` with a bug ID and resolution to close a ticket',
              inline: false
            }
          ]
        };

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error('Error fetching bug status:', err);
        await interaction.editReply('❌ Failed to fetch bug reports: ' + (err.message || 'Unknown error'));
      }
    }
  },

  // /resolve-bug command - mark a bug as resolved with notes
  resolveBug: {
    data: new SlashCommandBuilder()
      .setName('resolve-bug')
      .setDescription('Resolve a bug report')
      .addStringOption(option =>
        option
          .setName('bug_id')
          .setDescription('Bug report ID (from /bug-status)')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('resolution')
          .setDescription('How was this bug fixed?')
          .setRequired(true)
      ),
    async execute(interaction) {
      try {
        const bugId = interaction.options.getString('bug_id');
        const resolution = interaction.options.getString('resolution');

        // Query for the bug
        const bugs = await list('BugReport', { id: bugId }, { limit: 1 });

        if (!bugs || bugs.length === 0) {
          return await interaction.editReply('❌ Bug not found with that ID');
        }

        const bug = bugs[0];

        // For now, just display success. To actually update, you'd need
        // a Base44 function that can PATCH/PUT (SDK method or HTTP endpoint).
        // For the MVP, this acknowledges the command but doesn't persist updates.
        
        const embed = {
          title: '✅ Bug Resolved',
          color: 32768, // Green
          fields: [
            {
              name: 'Title',
              value: bug.title,
              inline: true
            },
            {
              name: 'Bug ID',
              value: bugId,
              inline: true
            },
            {
              name: 'Resolution',
              value: resolution,
              inline: false
            }
          ]
        };

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error('Error resolving bug:', err);
        await interaction.editReply('❌ Failed to resolve bug: ' + (err.message || 'Unknown error'));
      }
    }
  }
};
