#!/usr/bin/env node
/* =============================================================
   scripts/profile-stats.mjs
   Draws the GitHub activity cards on my profile README.

   Reads my public GitHub data (one GraphQL request) and writes a light
   and a dark version of three SVG cards into profile/:
     stats-light.svg / stats-dark.svg          contributions in the last
                                               year, streaks and totals
     languages-light.svg / languages-dark.svg  my most used languages
                                               across my public repositories
     activity-light.svg / activity-dark.svg    contributions per week for
                                               the last year

   The README shows the right one for the viewer's theme with <picture>.
   Nothing is fetched when someone views the profile: the cards are plain
   files in this repository, redrawn by .github/workflows/profile-stats.yml
   every Monday.

   Run it yourself (Node 18 or newer, no packages):
     GITHUB_TOKEN=<token> node scripts/profile-stats.mjs
     node scripts/profile-stats.mjs --sample path/to/saved-response.json

   A token with read access to public repositories is enough. Rows that
   would show zero (no stars yet, no streak right now) are left off the
   cards instead of showing 0.

   Troubleshooting
   - "GitHub answered 401": the token is missing or expired.
   - "Resource not accessible by integration": the workflow's built-in
     token can't read contribution data on this account. Add a
     fine-grained personal access token (public repositories, read-only)
     as the STATS_TOKEN secret; the workflow uses it when it exists.
   - A language looks too big: HTML from generated pages can outweigh
     code. Add it to HIDE_LANGUAGES below.
   ============================================================= */

import { mkdir, readFile, writeFile } from 'node:fs/promises';

/* ---------- Settings ---------- */

const LOGIN = 'ChristianRodriguez46';
const EXCLUDE_REPOS = ['ChristianRodriguez46']; // this profile repository
const HIDE_LANGUAGES = [];                       // e.g. ['HTML'] to leave it off the card
const TOP_LANGUAGES = 6;                         // the rest are grouped as "Other"
const OUTPUT_DIR = 'profile';
const SMALL_CARD = { width: 495, height: 220 }; // the two cards that sit side by side

const FONT = '-apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, Inter, Helvetica, Arial, sans-serif';

// The colors of my portfolio site. Every text pair keeps at least 4.5:1 contrast.
const THEMES = {
    light: { bg: '#ffffff', rim: '#d2d2d7', ink: '#1d1d1f', ink2: '#515156', track: '#e8e8ed', from: '#0071e3', to: '#5b4fe0' },
    dark: { bg: '#1d1d1f', rim: '#424245', ink: '#f5f5f7', ink2: '#a1a1a6', track: '#2c2c2e', from: '#2997ff', to: '#7d6ff0' }
};

const QUERY = `
query ($login: String!) {
  user(login: $login) {
    repositories(ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC, first: 100) {
      totalCount
      nodes {
        name
        stargazerCount
        languages(first: 20) { edges { size node { name color } } }
      }
    }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;


/* ---------- Reading the data ---------- */

async function fetchUser(token) {
    const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
            Authorization: `bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'profile-stats'
        },
        body: JSON.stringify({ query: QUERY, variables: { login: LOGIN } })
    });
    if (!response.ok) {
        throw new Error(`GitHub answered ${response.status} ${response.statusText}`);
    }
    const body = await response.json();
    if (body.errors) {
        throw new Error(body.errors.map((error) => error.message).join('; '));
    }
    return body.data.user;
}

// Turns GitHub's answer into the numbers the cards show.
function summarize(user) {
    const repos = user.repositories.nodes.filter((repo) => !EXCLUDE_REPOS.includes(repo.name));
    const contributions = user.contributionsCollection;
    const days = contributions.contributionCalendar.weeks.flatMap((week) => week.contributionDays);

    return {
        totalContributions: contributions.contributionCalendar.totalContributions,
        commits: contributions.totalCommitContributions,
        pullRequests: contributions.totalPullRequestContributions,
        issues: contributions.totalIssueContributions,
        repositories: repos.length,
        stars: repos.reduce((sum, repo) => sum + repo.stargazerCount, 0),
        ...streaks(days),
        weeks: contributions.contributionCalendar.weeks.map((week) => ({
            start: week.contributionDays[0].date,
            count: week.contributionDays.reduce((sum, day) => sum + day.contributionCount, 0)
        })),
        languages: topLanguages(repos)
    };
}

// Days in a row with at least one contribution. The current streak still
// counts if today has none yet.
function streaks(days) {
    let longest = 0;
    let run = 0;
    for (const day of days) {
        run = day.contributionCount > 0 ? run + 1 : 0;
        longest = Math.max(longest, run);
    }
    let current = 0;
    let i = days.length - 1;
    if (i >= 0 && days[i].contributionCount === 0) {
        i -= 1;
    }
    for (; i >= 0 && days[i].contributionCount > 0; i--) {
        current += 1;
    }
    return { currentStreak: current, longestStreak: longest };
}

// Bytes of code per language across my repositories, largest first, as
// shares of the total.
function topLanguages(repos) {
    const bytes = new Map();
    for (const repo of repos) {
        for (const { size, node } of repo.languages.edges) {
            if (HIDE_LANGUAGES.includes(node.name)) {
                continue;
            }
            const entry = bytes.get(node.name) || { name: node.name, color: node.color || '#8e8e93', size: 0 };
            entry.size += size;
            bytes.set(node.name, entry);
        }
    }
    const sorted = [...bytes.values()].sort((a, b) => b.size - a.size);
    const total = sorted.reduce((sum, entry) => sum + entry.size, 0);
    if (total === 0) {
        return [];
    }
    const top = sorted.slice(0, TOP_LANGUAGES);
    const rest = sorted.slice(TOP_LANGUAGES).reduce((sum, entry) => sum + entry.size, 0);
    if (rest > 0) {
        top.push({ name: 'Other', color: '#8e8e93', size: rest });
    }
    return top.map((entry) => ({ ...entry, share: entry.size / total }));
}


/* ---------- Drawing ---------- */

function escape(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function plural(count, word) {
    return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}

// Shared frame: rounded card, title, accent gradient.
function card(width, height, theme, title, label, body) {
    const t = THEMES[theme];
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="title">
  <title id="title">${escape(label)}</title>
  <defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.from}"/>
      <stop offset="1" stop-color="${t.to}"/>
    </linearGradient>
  </defs>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="20" fill="${t.bg}" stroke="${t.rim}"/>
  <text x="28" y="44" font-family="${FONT}" font-size="17" font-weight="600" fill="${t.ink}">${escape(title)}</text>
${body}
</svg>
`;
}

function drawStats(summary, theme) {
    const t = THEMES[theme];
    const big = [
        { value: summary.totalContributions, label: 'contributions in the last year' },
        { value: summary.currentStreak, label: 'day current streak' },
        { value: summary.longestStreak, label: 'day longest streak' }
    ].filter((item, index) => index === 0 || item.value > 0);

    const columnWidth = 439 / big.length;
    const columns = big.map((item, index) => {
        const x = 28 + index * columnWidth;
        return `  <text x="${x}" y="104" font-family="${FONT}" font-size="38" font-weight="700" letter-spacing="-1" fill="url(#accent)">${item.value.toLocaleString('en-US')}</text>
  <text x="${x}" y="128" font-family="${FONT}" font-size="13" fill="${t.ink2}">${escape(item.label)}</text>`;
    }).join('\n');

    const totals = [
        [summary.commits, 'commit'],
        [summary.pullRequests, 'pull request'],
        [summary.issues, 'issue'],
        [summary.repositories, 'public repository'],
        [summary.stars, 'star']
    ].filter(([count]) => count > 0)
        .map(([count, word]) => (word === 'public repository' && count !== 1 ? `${count} public repositories` : plural(count, word)))
        .join('  ·  ');

    const label = `The last 12 months on GitHub: ${summary.totalContributions} contributions` +
        (summary.currentStreak > 0 ? `, a ${summary.currentStreak}-day current streak` : '') +
        (summary.longestStreak > 0 ? `, a ${summary.longestStreak}-day longest streak` : '') +
        (totals ? `. ${totals.replace(/ {2}· {2}/g, ', ')}.` : '.');

    const body = `${columns}
  <line x1="28" y1="160" x2="467" y2="160" stroke="${t.track}"/>
  <text x="28" y="192" font-family="${FONT}" font-size="13" fill="${t.ink2}">${escape(totals)}</text>`;
    return card(SMALL_CARD.width, SMALL_CARD.height, theme, 'The last 12 months', label, body);
}

function drawLanguages(summary, theme) {
    const t = THEMES[theme];
    const languages = summary.languages;
    const barWidth = 439;

    let x = 28;
    const segments = languages.map((language) => {
        const width = Math.max(2, language.share * barWidth);
        const rect = `    <rect x="${x.toFixed(1)}" y="64" width="${width.toFixed(1)}" height="12" fill="${language.color}"/>`;
        x += width;
        return rect;
    }).join('\n');

    const legend = languages.map((language, index) => {
        const column = index % 2;
        const row = Math.floor(index / 2);
        const lx = 28 + column * 222;
        const ly = 110 + row * 26;
        return `  <circle cx="${lx + 6}" cy="${ly - 4}" r="6" fill="${language.color}"/>
  <text x="${lx + 20}" y="${ly}" font-family="${FONT}" font-size="14" fill="${t.ink}">${escape(language.name)} <tspan fill="${t.ink2}">${(language.share * 100).toFixed(1)}%</tspan></text>`;
    }).join('\n');

    const label = 'Most used languages: ' + languages.map((l) => `${l.name} ${(l.share * 100).toFixed(1)}%`).join(', ') + '.';
    const body = `  <clipPath id="bar"><rect x="28" y="64" width="${barWidth}" height="12" rx="6"/></clipPath>
  <rect x="28" y="64" width="${barWidth}" height="12" rx="6" fill="${t.track}"/>
  <g clip-path="url(#bar)">
${segments}
  </g>
${legend}`;
    return card(SMALL_CARD.width, SMALL_CARD.height, theme, 'Most used languages', label, body);
}

function drawActivity(summary, theme) {
    const t = THEMES[theme];
    const weeks = summary.weeks;
    const left = 28;
    const right = 972;
    const top = 70;
    const bottom = 196;
    const slot = (right - left) / weeks.length;
    const barWidth = Math.max(2, slot - 3);
    const most = Math.max(1, ...weeks.map((week) => week.count));

    const bars = weeks.map((week, index) => {
        const x = left + index * slot;
        const height = week.count === 0 ? 0 : Math.max(3, (week.count / most) * (bottom - top));
        if (height === 0) {
            return '';
        }
        return `  <rect x="${x.toFixed(1)}" y="${(bottom - height).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" rx="2" fill="url(#accent)"/>`;
    }).filter(Boolean).join('\n');

    // A month label under the first week of each month, if it has room.
    let lastLabelX = -Infinity;
    const months = weeks.map((week, index) => {
        const date = new Date(week.start + 'T00:00:00Z');
        const previous = index > 0 ? new Date(weeks[index - 1].start + 'T00:00:00Z') : null;
        const x = left + index * slot;
        if ((previous && previous.getUTCMonth() === date.getUTCMonth()) || x - lastLabelX < 44) {
            return '';
        }
        lastLabelX = x;
        const name = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
        return `  <text x="${x.toFixed(1)}" y="220" font-family="${FONT}" font-size="12" fill="${t.ink2}">${name}</text>`;
    }).filter(Boolean).join('\n');

    const busiest = weeks.reduce((best, week) => (week.count > best.count ? week : best), weeks[0]);
    const label = `Contributions per week over the last year. Busiest week: ${busiest.count} contributions, starting ${busiest.start}.`;
    const body = `  <text x="972" y="44" text-anchor="end" font-family="${FONT}" font-size="13" fill="${t.ink2}">most in a week: ${most}</text>
  <line x1="${left}" y1="${bottom + 0.5}" x2="${right}" y2="${bottom + 0.5}" stroke="${t.track}"/>
${bars}
${months}`;
    return card(1000, 240, theme, 'Contributions per week', label, body);
}


/* ---------- Run ---------- */

async function main() {
    const sampleIndex = process.argv.indexOf('--sample');
    let user;
    if (sampleIndex !== -1) {
        user = JSON.parse(await readFile(process.argv[sampleIndex + 1], 'utf8'));
    } else {
        const token = process.env.GITHUB_TOKEN;
        if (!token) {
            throw new Error('Set GITHUB_TOKEN, or pass --sample <file>.');
        }
        user = await fetchUser(token);
    }

    const summary = summarize(user);
    await mkdir(OUTPUT_DIR, { recursive: true });
    for (const theme of Object.keys(THEMES)) {
        await writeFile(`${OUTPUT_DIR}/stats-${theme}.svg`, drawStats(summary, theme));
        await writeFile(`${OUTPUT_DIR}/languages-${theme}.svg`, drawLanguages(summary, theme));
        await writeFile(`${OUTPUT_DIR}/activity-${theme}.svg`, drawActivity(summary, theme));
    }
    console.log(`Drew the cards: ${summary.totalContributions} contributions, ` +
        `${summary.languages.length} languages, ${summary.weeks.length} weeks.`);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
