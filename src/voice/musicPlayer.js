import { spawn } from 'node:child_process';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType
} from '@discordjs/voice';
import play from 'play-dl';
import ffmpegPath from 'ffmpeg-static';
import { ensureYtDlpBinary } from './ytdlp-binary.js';

// One state object per guild: connection, player, queue, history, anchor channels
const guildStates = new Map();

function getOrCreateState(guildId) {
  let state = guildStates.get(guildId);
  if (!state) {
    state = {
      connection: null,
      player: null,
      voiceChannelId: null,
      textChannelId: null,
      queue: [],
      current: null,
      playedVideoIds: new Set(),
      autoplaying: false,
      activeProcesses: null
    };
    guildStates.set(guildId, state);
  }
  return state;
}

export function getMusicState(guildId) {
  return guildStates.get(guildId) || null;
}

function extractTags(videoDetails) {
  const tags = Array.isArray(videoDetails?.tags) ? videoDetails.tags.slice(0, 5) : [];
  if (tags.length > 0) return tags;
  // Fall back to channel name as a loose genre anchor
  return videoDetails?.channel?.name ? [videoDetails.channel.name] : [];
}

async function resolveTrackFromQuery(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return null;

  const isUrl = play.yt_validate(trimmed) === 'video';

  if (isUrl) {
    const info = await play.video_basic_info(trimmed);
    const details = info?.video_details;
    if (!details) return null;
    return {
      url: details.url,
      title: details.title,
      durationRaw: details.durationRaw,
      tags: extractTags(details)
    };
  }

  const results = await play.search(trimmed, { limit: 1, source: { youtube: 'video' } });
  const found = results?.[0];
  if (!found) return null;
  return {
    url: found.url,
    title: found.title,
    durationRaw: found.durationRaw,
    tags: extractTags(found)
  };
}

async function findAutoplayTrack(state) {
  const seed = state.current;
  if (!seed) return null;

  const keyword = seed.tags?.[0] || seed.title;
  if (!keyword) return null;

  try {
    const results = await play.search(keyword, { limit: 10, source: { youtube: 'video' } });
    const candidate = (results || []).find((video) => !state.playedVideoIds.has(video.url));
    if (!candidate) return null;
    return {
      url: candidate.url,
      title: candidate.title,
      durationRaw: candidate.durationRaw,
      tags: extractTags(candidate),
      isAutoplay: true
    };
  } catch (error) {
    console.warn('⚠️ Autoplay search failed:', error.message);
    return null;
  }
}

function killTrackProcesses(state) {
  if (state.activeProcesses) {
    state.activeProcesses.ytdlp?.kill();
    state.activeProcesses.ffmpeg?.kill();
    state.activeProcesses = null;
  }
}

async function createTrackResource(url) {
  const ytdlpBinaryPath = await ensureYtDlpBinary();
  const ytdlpProcess = spawn(ytdlpBinaryPath, ['-f', 'bestaudio', '-o', '-', '--quiet', '--no-warnings', url]);
  const ffmpegProcess = spawn(ffmpegPath, [
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  ]);

  ytdlpProcess.stdout.pipe(ffmpegProcess.stdin);
  ytdlpProcess.on('error', (err) => console.warn('⚠️ yt-dlp spawn error:', err.message));
  ffmpegProcess.on('error', (err) => console.warn('⚠️ ffmpeg spawn error:', err.message));
  ytdlpProcess.stderr.on('data', (chunk) => console.warn('[yt-dlp]', chunk.toString().trim()));
  ffmpegProcess.stderr.on('data', (chunk) => console.warn('[ffmpeg]', chunk.toString().trim()));
  ytdlpProcess.on('close', (code) => {
    if (code !== 0 && code !== null) console.warn(`⚠️ yt-dlp exited with code ${code}`);
  });
  ffmpegProcess.on('close', (code) => {
    if (code !== 0 && code !== null) console.warn(`⚠️ ffmpeg exited with code ${code}`);
  });

  return {
    stream: ffmpegProcess.stdout,
    processes: { ytdlp: ytdlpProcess, ffmpeg: ffmpegProcess }
  };
}

async function playTrack(guild, state, track) {
  killTrackProcesses(state);

  const { stream, processes } = await createTrackResource(track.url);
  const resource = createAudioResource(stream, { inputType: StreamType.Raw });

  state.current = track;
  state.activeProcesses = processes;
  state.playedVideoIds.add(track.url);
  state.player.play(resource);

  const channel = state.textChannelId
    ? await guild.channels.fetch(state.textChannelId).catch(() => null)
    : null;

  if (channel?.isTextBased?.()) {
    const prefix = track.isAutoplay ? '📻 Autoplay (même ambiance)' : '🎵 Lecture';
    await channel.send(`${prefix}: **${track.title}**`).catch(() => {});
  }
}

async function advanceQueue(guild, state) {
  if (state.queue.length > 0) {
    const next = state.queue.shift();
    await playTrack(guild, state, next);
    return;
  }

  const autoplayTrack = await findAutoplayTrack(state);
  if (autoplayTrack) {
    await playTrack(guild, state, autoplayTrack);
    return;
  }

  state.current = null;
}

export async function joinMusicChannel(guild, voiceChannelId, textChannelId) {
  const state = getOrCreateState(guild.id);
  state.voiceChannelId = voiceChannelId;
  state.textChannelId = textChannelId || state.textChannelId;

  if (!state.player) {
    state.player = createAudioPlayer();
    state.player.on(AudioPlayerStatus.Idle, () => {
      advanceQueue(guild, state).catch((error) => {
        console.warn('⚠️ advanceQueue failed:', error.message);
      });
    });
    state.player.on('error', (error) => {
      console.warn('⚠️ Audio player error:', error.message);
      advanceQueue(guild, state).catch(() => {});
    });
  }

  if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed) {
    state.connection = joinVoiceChannel({
      channelId: voiceChannelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator
    });
    await entersState(state.connection, VoiceConnectionStatus.Ready, 15_000);
    state.connection.subscribe(state.player);
  }

  return state;
}

export async function enqueueTrack(guild, query) {
  const state = getOrCreateState(guild.id);
  const track = await resolveTrackFromQuery(query);
  if (!track) {
    return { ok: false, reason: 'Aucun résultat trouvé pour cette recherche.' };
  }

  state.queue.push(track);

  if (!state.current) {
    await advanceQueue(guild, state);
    return { ok: true, track, position: 0 };
  }

  return { ok: true, track, position: state.queue.length };
}

export function skipTrack(guildId) {
  const state = getMusicState(guildId);
  if (!state?.player || !state.current) {
    return false;
  }
  state.player.stop(true);
  return true;
}

export function stopMusic(guildId) {
  const state = getMusicState(guildId);
  if (!state) return false;

  state.queue = [];
  state.current = null;
  killTrackProcesses(state);
  state.player?.stop(true);
  state.connection?.destroy();
  state.connection = null;
  return true;
}

export function getQueueSnapshot(guildId) {
  const state = getMusicState(guildId);
  if (!state) return { current: null, queue: [] };
  return { current: state.current, queue: state.queue.slice(0, 10) };
}
