/**
 * WebRTC Peer Connection Manager for Consent-Based Remote Support
 * Handles SDP offer/answer exchange, ICE candidates, and clean track lifecycle.
 */
export class WebRTCManager {
  constructor({ role, onRemoteStream, onSignal, onConnectionStateChange }) {
    this.role = role; // 'operator' or 'recipient'
    this.onRemoteStream = onRemoteStream || (() => {});
    this.onSignal = onSignal || (() => {});
    this.onConnectionStateChange = onConnectionStateChange || (() => {});

    this.peerConnection = null;
    this.localStream = null;
    this.iceCandidateQueue = [];
    this.isNegotiating = false;

    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };
  }

  /**
   * Initializes the RTCPeerConnection instance.
   */
  initPeerConnection() {
    if (this.peerConnection) return this.peerConnection;

    this.peerConnection = new RTCPeerConnection(this.rtcConfig);

    // Relay local ICE candidates to peer via signaling
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.onSignal({
          type: 'candidate',
          candidate: event.candidate
        });
      }
    };

    // Handle incoming remote media tracks
    this.peerConnection.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        this.onRemoteStream(event.streams[0], event.track);
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (this.peerConnection) {
        this.onConnectionStateChange(this.peerConnection.connectionState);
      }
    };

    return this.peerConnection;
  }

  /**
   * Attaches a local MediaStream to the connection.
   */
  setLocalStream(stream) {
    this.initPeerConnection();
    this.localStream = stream;

    // Add each track to peer connection
    stream.getTracks().forEach((track) => {
      this.peerConnection.addTrack(track, stream);
    });
  }

  /**
   * Stops and removes tracks cleanly upon permission revocation.
   */
  removeTrackByKind(kind) {
    if (!this.peerConnection) return;

    const senders = this.peerConnection.getSenders();
    senders.forEach((sender) => {
      if (sender.track && sender.track.kind === kind) {
        sender.track.stop();
        this.peerConnection.removeTrack(sender);
      }
    });

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        if (track.kind === kind) {
          track.stop();
        }
      });
    }
  }

  /**
   * Initiates an SDP Offer (typically triggered by the recipient when media starts).
   */
  async createOffer() {
    this.initPeerConnection();
    try {
      this.isNegotiating = true;
      const offer = await this.peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      await this.peerConnection.setLocalDescription(offer);
      this.onSignal(this.peerConnection.localDescription);
    } catch (err) {
      console.error('[WebRTC createOffer Error]:', err);
    } finally {
      this.isNegotiating = false;
    }
  }

  /**
   * Processes an incoming signaling message (offer, answer, or candidate).
   */
  async handleSignal(signal) {
    this.initPeerConnection();

    try {
      if (signal.type === 'offer') {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
        // Flush any queued candidates
        while (this.iceCandidateQueue.length > 0) {
          const candidate = this.iceCandidateQueue.shift();
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
        // Respond with answer
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        this.onSignal(this.peerConnection.localDescription);
      } else if (signal.type === 'answer') {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
        // Flush queued candidates
        while (this.iceCandidateQueue.length > 0) {
          const candidate = this.iceCandidateQueue.shift();
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
      } else if (signal.type === 'candidate' && signal.candidate) {
        if (this.peerConnection.remoteDescription && this.peerConnection.remoteDescription.type) {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } else {
          this.iceCandidateQueue.push(signal.candidate);
        }
      }
    } catch (err) {
      console.error('[WebRTC handleSignal Error]:', err);
    }
  }

  /**
   * Completely terminates all media tracks and the peer connection.
   */
  teardown() {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
      this.localStream = null;
    }

    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch {}
      this.peerConnection = null;
    }

    this.iceCandidateQueue = [];
  }
}
