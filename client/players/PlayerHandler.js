import LocalPlayer from './LocalPlayer'
import CastPlayer from './CastPlayer'
import AudioTrack from './AudioTrack'

export default class PlayerHandler {
  constructor(ctx) {
    this.ctx = ctx
    this.libraryItem = null
    this.playWhenReady = false
    this.player = null
    this.playerState = 'IDLE'
    this.isHlsTranscode = false
    this.currentSessionId = null
    this.startTime = 0

    this.lastSyncTime = 0
    this.lastSyncedAt = 0
    this.listeningTimeSinceSync = 0

    this.playInterval = null
  }

  get isCasting() {
    return this.ctx.$store.state.globals.isCasting
  }
  get isPlayingCastedItem() {
    return this.libraryItem && (this.player instanceof CastPlayer)
  }
  get isPlayingLocalItem() {
    return this.libraryItem && (this.player instanceof LocalPlayer)
  }
  get userToken() {
    return this.ctx.$store.getters['user/getToken']
  }
  get playerPlaying() {
    return this.playerState === 'PLAYING'
  }

  load(libraryItem, playWhenReady) {
    if (!this.player) this.switchPlayer()

    this.libraryItem = libraryItem
    this.playWhenReady = playWhenReady
    this.prepare()
  }

  switchPlayer() {
    if (this.isCasting && !(this.player instanceof CastPlayer)) {
      console.log('[PlayerHandler] Switching to cast player')

      this.stopPlayInterval()
      this.playerStateChange('LOADING')

      this.startTime = this.player ? this.player.getCurrentTime() : this.startTime
      if (this.player) {
        this.player.destroy()
      }
      this.player = new CastPlayer(this.ctx)
      this.setPlayerListeners()

      if (this.libraryItem) {
        // libraryItem was already loaded - prepare for cast
        this.playWhenReady = false
        this.prepare()
      }
    } else if (!this.isCasting && !(this.player instanceof LocalPlayer)) {
      console.log('[PlayerHandler] Switching to local player')

      this.stopPlayInterval()
      this.playerStateChange('LOADING')

      if (this.player) {
        this.player.destroy()
      }
      this.player = new LocalPlayer(this.ctx)
      this.setPlayerListeners()

      if (this.libraryItem) {
        // libraryItem was already loaded - prepare for local play
        this.playWhenReady = false
        this.prepare()
      }
    }
  }

  setPlayerListeners() {
    this.player.on('stateChange', this.playerStateChange.bind(this))
    this.player.on('timeupdate', this.playerTimeupdate.bind(this))
    this.player.on('buffertimeUpdate', this.playerBufferTimeUpdate.bind(this))
    this.player.on('error', this.playerError.bind(this))
  }

  playerError() {
    // Switch to HLS stream on error
    if (!this.isCasting && !this.currentStreamId && (this.player instanceof LocalPlayer)) {
      console.log(`[PlayerHandler] Audio player error switching to HLS stream`)
      this.prepare(true)
    }
  }

  playerStateChange(state) {
    console.log('[PlayerHandler] Player state change', state)
    this.playerState = state
    if (this.playerState === 'PLAYING') {
      this.startPlayInterval()
    } else {
      this.stopPlayInterval()
    }
    if (this.playerState === 'LOADED' || this.playerState === 'PLAYING') {
      this.ctx.setDuration(this.player.getDuration())
    }
    if (this.playerState !== 'LOADING') {
      this.ctx.setCurrentTime(this.player.getCurrentTime())
    }

    this.ctx.isPlaying = this.playerState === 'PLAYING'
    this.ctx.playerLoading = this.playerState === 'LOADING'
  }

  playerTimeupdate(time) {
    this.ctx.setCurrentTime(time)
  }

  playerBufferTimeUpdate(buffertime) {
    this.ctx.setBufferTime(buffertime)
  }

  async prepare(forceTranscode = false) {
    var payload = {
      supportedMimeTypes: Object.keys(this.player.playableMimeTypes),
      mediaPlayer: this.isCasting ? 'chromecast' : 'html5',
      forceTranscode,
      forceDirectPlay: this.isCasting // TODO: add transcode support for chromecast
    }
    var session = await this.ctx.$axios.$post(`/api/items/${this.libraryItem.id}/play`, payload).catch((error) => {
      console.error('Failed to start stream', error)
    })
    this.prepareSession(session)
  }

  prepareOpenSession(session) { // Session opened on init socket
    if (!this.player) this.switchPlayer()

    this.libraryItem = session.libraryItem
    this.playWhenReady = false
    this.prepareSession(session)
  }

  prepareSession(session) {
    this.startTime = session.currentTime
    this.currentSessionId = session.id

    console.log('[PlayerHandler] Preparing Session', session)
    var audioTracks = session.audioTracks.map(at => new AudioTrack(at, this.userToken))

    this.ctx.playerLoading = true
    this.isHlsTranscode = true
    if (session.playMethod === this.ctx.$constants.PlayMethod.DIRECTPLAY) {
      this.isHlsTranscode = false
    }

    this.player.set(this.libraryItem, audioTracks, this.isHlsTranscode, this.startTime, this.playWhenReady)
  }

  closePlayer() {
    console.log('[PlayerHandler] Close Player')
    this.sendCloseSession()
    if (this.player) {
      this.player.destroy()
    }
    this.player = null
    this.playerState = 'IDLE'
    this.libraryItem = null
    this.startTime = 0
    this.stopPlayInterval()
  }

  resetStream(startTime, streamId) {
    if (this.isHlsTranscode && this.currentSessionId === streamId) {
      this.player.resetStream(startTime)
    } else {
      console.warn('resetStream mismatch streamId', this.currentSessionId, streamId)
    }
  }

  startPlayInterval() {
    clearInterval(this.playInterval)
    var lastTick = Date.now()
    this.playInterval = setInterval(() => {
      // Update UI
      if (!this.player) return
      var currentTime = this.player.getCurrentTime()
      this.ctx.setCurrentTime(currentTime)

      var exactTimeElapsed = ((Date.now() - lastTick) / 1000)
      lastTick = Date.now()
      this.listeningTimeSinceSync += exactTimeElapsed
      if (this.listeningTimeSinceSync >= 5) {
        this.sendProgressSync(currentTime)
      }
    }, 1000)
  }

  sendCloseSession() {
    var syncData = null
    if (this.player) {
      var listeningTimeToAdd = Math.max(0, Math.floor(this.listeningTimeSinceSync))
      syncData = {
        timeListened: listeningTimeToAdd,
        currentTime: this.player.getCurrentTime()
      }
    }
    this.listeningTimeSinceSync = 0
    return this.ctx.$axios.$post(`/api/session/${this.currentSessionId}/close`, syncData, { timeout: 1000 }).catch((error) => {
      console.error('Failed to close session', error)
    })
  }

  sendProgressSync(currentTime) {
    var diffSinceLastSync = Math.abs(this.lastSyncTime - currentTime)
    if (diffSinceLastSync < 1) return

    this.lastSyncTime = currentTime
    var listeningTimeToAdd = Math.max(0, Math.floor(this.listeningTimeSinceSync))
    var syncData = {
      timeListened: listeningTimeToAdd,
      currentTime
    }
    this.listeningTimeSinceSync = 0
    this.ctx.$axios.$post(`/api/session/${this.currentSessionId}/sync`, syncData, { timeout: 1000 }).catch((error) => {
      console.error('Failed to update session progress', error)
    })
  }

  stopPlayInterval() {
    clearInterval(this.playInterval)
    this.playInterval = null
  }

  playPause() {
    if (this.player) this.player.playPause()
  }

  play() {
    if (this.player) this.player.play()
  }

  pause() {
    if (this.player) this.player.pause()
  }

  getCurrentTime() {
    return this.player ? this.player.getCurrentTime() : 0
  }

  getDuration() {
    return this.player ? this.player.getDuration() : 0
  }

  jumpBackward() {
    if (!this.player) return
    var currentTime = this.getCurrentTime()
    this.seek(Math.max(0, currentTime - 10))
  }

  jumpForward() {
    if (!this.player) return
    var currentTime = this.getCurrentTime()
    this.seek(Math.min(currentTime + 10, this.getDuration()))
  }

  setVolume(volume) {
    if (!this.player) return
    this.player.setVolume(volume)
  }

  setPlaybackRate(playbackRate) {
    if (!this.player) return
    this.player.setPlaybackRate(playbackRate)
  }

  seek(time) {
    if (!this.player) return
    this.player.seek(time, this.playerPlaying)
    this.ctx.setCurrentTime(time)

    // Update progress if paused
    if (!this.playerPlaying) {
      this.sendProgressSync(time)
    }
  }
}