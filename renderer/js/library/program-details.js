// What every source knows about one program, merged for the screens that
// show it (the I card, the cable-guide program page, the guide's INFO).
// Sources, each optional and saved on the playlist entry by whoever found it:
//   file.series        series name, season, episode (library, NFO, TVmaze)
//   file.tmdb          TMDB Metadata: poster, cast, and an episode's air date
//   file.tvmaze        TVmaze Episodes: network, air date and time, show image
//   file.poster        a local poster or thumbnail beside the file (NFO pass)
//
// Pure: no DOM. A local poster is returned as a path; the caller turns it
// into a URL (window.api.toFileUrl).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const hasText = (value) => typeof value === 'string' && value.trim() !== '';
const intOr = (...values) => values.find((v) => Number.isInteger(v)) ?? null;

/** "2005-09-20" -> "September 20, 2005"; a bare year stays a year. */
export function formatAirDate(iso) {
  const match = /^(\d{4})(?:-(\d{2})-(\d{2}))?/.exec(String(iso || ''));
  if (!match) return '';
  if (!match[2]) return match[1];
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : match[1];
}

export function programDetails(file) {
  const f = file || {};
  const tmdb = f.tmdb || {};
  const tvmaze = f.tvmaze || {};
  const series = f.series || {};
  const tmdbEpisode = tmdb.episode || null;
  const seriesName = (hasText(series.name) && series.name.trim()) || (hasText(tvmaze.show) && tvmaze.show) || null;
  const title = hasText(f.title) ? f.title.trim() : null;
  const episodeTitle = (title && seriesName && title.toLowerCase() !== seriesName.toLowerCase() ? title : null)
    || (tmdbEpisode && tmdbEpisode.name) || null;
  const airDate = tvmaze.airdate || (tmdbEpisode && tmdbEpisode.airDate) || null;
  return {
    seriesName,
    episodeTitle,
    season: intOr(tmdbEpisode && tmdbEpisode.season, tvmaze.season, series.season),
    episode: intOr(tmdbEpisode && tmdbEpisode.number, tvmaze.number, series.episode),
    firstAired: airDate ? { date: airDate, network: tvmaze.network || null } : null,
    cast: (Array.isArray(tmdb.cast) ? tmdb.cast : []).map((name) => String(name || '').trim()).filter(Boolean),
    imageUrl: tmdb.posterUrl || tvmaze.imageUrl || null,
    posterPath: hasText(f.poster) ? f.poster : null,
    schedule: tvmaze.schedule || null,
  };
}

/** "S2 E1", or '' when the season or episode is unknown. */
export function episodeLabel(details) {
  return details && details.season != null && details.episode != null ? `S${details.season} E${details.episode}` : '';
}

/**
 * The closing sentences the real boxes ran after a description:
 * "Starring A, B and C. First aired September 20, 2005 on A Network."
 */
export function creditSentences(details) {
  const out = [];
  const cast = (details && details.cast) || [];
  if (cast.length) {
    const names = cast.length > 1 ? `${cast.slice(0, -1).join(', ')} and ${cast[cast.length - 1]}` : cast[0];
    out.push(`Starring ${names}.`);
  }
  const aired = details && details.firstAired;
  const when = aired && formatAirDate(aired.date);
  if (when) out.push(`First aired ${/^\d{4}$/.test(when) ? 'in ' : ''}${when}${aired.network ? ` on ${aired.network}` : ''}.`);
  return out.join(' ');
}
