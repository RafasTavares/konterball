import {TweenMax, TimelineMax, Power0, Power1, Power2, Power4, Expo} from 'gsap';
import $ from 'zepto-modules';
import FPS from 'fps';
import {
  Scene as ThreeScene,
  WebGLRenderer,
  TextureLoader,
  BasicShadowMap,
  SphereGeometry,
  PerspectiveCamera,
  DirectionalLight,
  AmbientLight,
  Raycaster,
  PlaneGeometry,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  Vector2,
  Euler,
  CatmullRomCurve3,
  TubeGeometry,
  Texture,
} from 'three';
import OBJLoader from './three/OBJLoader';
import VREffect from './three/VREffect';
import VRControls from './three/VRControls';
import ViveController from './three/ViveController';

import {STATE, MODE, INITIAL_CONFIG, EVENT, CONTROLMODE} from './constants';
import {cap, mirrorPosition, mirrorVelocity, setTransparency} from './util/helpers';
import VR_MODES from './webvr-manager/modes';
import Physics from './physics';
import Hud from './hud';
import SoundManager from './sound-manager';
import WebVRManager from './webvr-manager';
import Util from './webvr-manager/util';
import Time from './util/time';

import Table from './models/table';
import Net from './models/net';
import Ball from './models/ball';
import Crosshair from './models/crosshair';
import setupPaddles from './models/paddle';

const DEBUG_MODE = false;

/* global CannonDebugRenderer */

export default class Scene {
  constructor(emitter, communication) {
    this.emitter = emitter;
    this.communication = communication;
    this.config = Object.assign({}, INITIAL_CONFIG);
    // for requestanimationframe-based timeouts and intervals
    this.time = new Time();
    this.sound = new SoundManager(this.config);
    this.score = {
      self: 0,
      opponent: 0,
      lives: this.config.startLives,
      highest: 0,
    };

    // THREE.JS
    // can be MOUSE or VR
    this.controlMode = CONTROLMODE.MOUSE;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    // three.js VRControls
    this.controls = null;
    // the active vive controller
    this.controller = null;
    // three.js VREffect
    this.effect = null;
    // VR display
    this.display = null;
    this.textureLoader = new TextureLoader();
    this.textureLoader.setPath('/textures/');
    this.objLoader = new OBJLoader();
    this.objLoader.setPath('/models/');
    // three.js meshes
    this.table = null;
    this.tablePlane = null;
    this.net = null;
    this.ball = null;
    this.crossHair = null;
    // vive controllers
    this.controller1 = null;
    this.controller2 = null;
    // vr manager
    this.manager = null;
    // three.js raycaster
    this.raycaster = null;

    // PHYSICS
    // when enabled, renders all cannon objects as wireframes
    this.physicsDebugRenderer = null;
    this.physicsTimeStep = 1000;
    this.physics = new Physics(this.config, this.emitter);

    // MULTIPLAYER
    // resetBallTimeout is used to reset the ball after it landed on the floor
    this.resetBallTimeout = null;
    // for determining whose point it is
    this.ballHasHitEnemyTable = false;
    // changes to 3000 in multiplayer mode, because it takes the ball longer to
    // travel to the other side of the table than just the folded table half
    this.resetTimeoutDuration = 1500;
    // used to coordinate restarts
    this.playerRequestedRestart = false;
    this.opponentRequestedRestart = false;
    // used to coordinate countdowns
    this.playerRequestedCountdown = false;
    this.opponentRequestedCountdown = false;
    // used to animate the ball from the position
    // where it should be to the position that was received over the wire
    this.ballInterpolationAlpha = 0;

    // ANIMATION
    // stores the last hit for the hit animation
    this.lastHitPosition = null;
    // used to animate a hit (the paddle quickly moves towards the ball and
    // back to the position it should be in according to the controller
    this.paddleInterpolationAlpha = 0;
    // we need this also for the hit animation. always stores where the paddle
    // is according to the controls, so we can interpolate between that and the
    // hit position
    this.ghostPaddlePosition = new Vector3();
    // so the paddle doesn't repeatedly hit the ball during the animation
    this.hitAvailable = true;

    // CONTROLS
    this.pointerIsLocked = false;
    // mouse moves for when the pointer is locked
    this.mouseMoveSinceLastFrame = {
      x: 0,
      y: 0,
    };
    // mouse position for when the pointer is not locked
    this.mousePosition = {
      x: 0,
      y: 0,
    };
    this.isMobile = Util.isMobile();

    // store fps for reducing image quality if too low
    this.fps = FPS({
      every: 10,
      decay: 0.1,
    });
    // count the frames
    this.frameNumber = 0;
    // first frame after tab became active again, when tab is in background the
    // framerate drops so we have to ignore that in the fps counter
    this.firstActiveFrame = 0;
    // timestamp of when the scene was last rendered
    this.lastRender = 0;
    // false if tab is switched, window hidden, app closed etc.
    this.tabActive = true;
  }

  setup() {
    return new Promise(resolve => {
      this.setupThree();
      this.setupVR();
      this.net = Net(this.scene, this.config);

      this.renderer.domElement.requestPointerLock
        = this.renderer.domElement.requestPointerLock
        || this.renderer.domElement.mozRequestPointerLock;

      this.renderer.domElement.onclick = () => {
        if (this.config.state !== STATE.GAME_OVER
         && this.renderer.domElement.requestPointerLock) {
          this.renderer.domElement.requestPointerLock();
        }
      };

      this.physics.setupWorld();

      if (DEBUG_MODE) {
        this.physicsDebugRenderer = new CannonDebugRenderer(this.scene, this.physics.world);
      }

      this.setupEventListeners();
      this.setupTablePlane();
      this.setupLights();
      this.setupEffects();

      this.hud = new Hud(this.scene, this.config, this.emitter, this.objLoader);
      this.crosshair = new Crosshair(this.scene, this.config);
      this.crosshair.visible = false;

      Promise.all([
        setupPaddles(this.objLoader, this.config, this.scene),
        this.hud.setup(),
      ]).then(([{paddle, paddleOpponent}]) => {
        this.paddle = paddle;
        this.paddleOpponent = paddleOpponent;
        this.paddle.position.copy(this.computePaddlePosition() || new Vector3());
        this.ghostPaddlePosition.copy(this.paddle.position);
        resolve('loaded');
      }).catch(e => {
        console.warn(e);
      });
    });
  }

  setupEventListeners() {
    this.emitter.on(EVENT.GAME_OVER, this.onGameOver.bind(this));
    this.emitter.on(EVENT.BALL_TABLE_COLLISION, this.onBallTableCollision.bind(this));
    this.emitter.on(EVENT.RESTART_BUTTON_PRESSED, this.onRestartButtonPressed.bind(this));
    this.emitter.on(EVENT.EXIT_BUTTON_PRESSED, () => {
      this.hud.message.setMessage('take off vr device');
    });
    this.emitter.on(EVENT.BALL_NET_COLLISION, () => {
      this.sound.playUI('net');
    });

    this.renderer.domElement.addEventListener('mousemove', this.onMouseMove.bind(this), false);
    $(this.renderer.domElement).click(() => {
      this.hud.message.click();
    });

    if ('onpointerlockchange' in document) {
      document.addEventListener('pointerlockchange', this.onPointerLockChange.bind(this), false);
    } else if ('onmozpointerlockchange' in document) {
      document.addEventListener('mozpointerlockchange', this.onPointerLockChange.bind(this), false);
    }
    $(window).on('resize', this.onResize.bind(this));
    $(window).on('vrdisplaypresentchange', this.onResize.bind(this));

    this.fps.on('data', framerate => {
      if (this.tabActive && this.frameNumber - this.firstActiveFrame > 100 && framerate < 30) {
        console.warn('throttling frame rate');
        // set only half pixel density, this brings a huge speed boost for a
        // loss of image quality
        this.light.shadow.mapSize.width = 512;
        this.light.shadow.mapSize.height = 512;
        this.renderer.setPixelRatio(window.devicePixelRatio / 2);
      }
    });
  }

  onBallPaddleCollision(point) {
    // the ball collided with the players paddle
    if (this.hitTween && this.hitTween.isActive()) {
      return;
    }
    this.physics.onBallPaddleCollision({body: this.physics.ball, target: this.paddle});
    this.ballHitAnimation();
    this.haloAnimation(point);
    this.ballPositionDifference = null;
    this.restartPingpongTimeout();
    this.ballHasHitEnemyTable = false;
    this.sound.paddle(point);
    if (this.config.mode === MODE.SINGLEPLAYER) {
      this.score.self += 1;
      this.hud.scoreDisplay.setSelfScore(this.score.self);
      return;
    }
    this.slowdownBall();
    this.communication.sendHit({
      x: point.x,
      y: point.y,
      z: point.z,
    }, {
      x: this.physics.ball.velocity.x,
      y: this.physics.ball.velocity.y,
      z: this.physics.ball.velocity.z,
    });
  }

  onBallTableCollision(body, target) {
    this.sound.table(body.position, this.physics.ball.velocity);
    // eslint-disable-next-line
    if (target._name === 'table-2-player' && body.position.z < this.config.tablePositionZ) {
      this.ballHasHitEnemyTable = true;
    }
  }

  onGameOver() {
    this.ballPath = null;
    this.sound.playLoop('bass-pad-synth');
    this.ball.visible = false;
    this.paddle.visible = false;
    this.paddleOpponent.visible = false;
    this.config.state = STATE.GAME_OVER;
    this.time.clearTimeout(this.resetBallTimeout);
    this.crosshair.visible = true;
    if (this.config.mode === MODE.SINGLEPLAYER) {
      this.hud.message.gameOver(this.score);
      this.sound.playUI('win');
    } else {
      this.hud.message.gameOver(this.score);
      if (this.score.self > this.score.opponent) {
        this.sound.playUI('win');
      } else {
        this.sound.playUI('lose');
      }
    }
    // make it look like there is an overlay between the ui layer and the table
    setTransparency(this.table, 0.2);
    setTransparency(this.net, 0.2);
    this.hud.scoreDisplay.hide();
    this.hud.message.showMessage();
  }

  onRestartButtonPressed() {
    this.hud.message.hideMessage();
    if (this.config.mode === MODE.MULTIPLAYER) {
      this.playerRequestedRestart = true;
      this.hud.message.setMessage('waiting');
      this.hud.message.showMessage();
      this.communication.sendRestartGame();
    }
    this.restartGame();
  }

  onResize() {
    this.effect.setSize(window.innerWidth, window.innerHeight, true);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.viewport = {
      width: $(this.renderer.domElement).width(),
      height: $(this.renderer.domElement).height(),
    };
  }

  onMouseMove(e) {
    if (!this.paddle || !this.viewport) {
      return;
    }
    if (this.pointerIsLocked) {
      // mouse can move infinitely in all directions
      this.mouseMoveSinceLastFrame.x += e.movementX;
      this.mouseMoveSinceLastFrame.y += e.movementY;
    } else {
      // mouse is confined to viewport
      this.mousePosition.x = e.offsetX / this.viewport.width - 0.5;
      this.mousePosition.y = -(e.offsetY / this.viewport.height - 0.5);
    }
  }

  onPointerLockChange() {
    if (document.pointerLockElement === this.renderer.domElement
      || document.mozPointerLockElement === this.renderer.domElement) {
      this.pointerIsLocked = true;
    } else {
      this.pointerIsLocked = false;
    }
  }

  setupVRControls() {
    // apply VR headset positional data to camera.
    this.controls = new VRControls(this.camera);
    this.controls.standing = true;
    this.controls.userHeight = this.config.cameraHeight;
    this.setupControllers();
  }

  setupVR() {
    // apply VR stereo rendering to renderer.
    this.effect = new VREffect(this.renderer);
    this.effect.setSize(window.innerWidth, window.innerHeight);

    // create a VR manager helper to enter and exit VR mode.
    const params = {
      hideButton: false,
      isUndistorted: false,
    };

    this.manager = new WebVRManager(this.renderer, this.effect, params);
  }

  setupThree() {
    this.renderer = new WebGLRenderer({antialias: true});
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = BasicShadowMap;

    document.body.appendChild(this.renderer.domElement);

    this.scene = new ThreeScene();
    this.camera = new PerspectiveCamera(47, window.innerWidth / window.innerHeight, 0.1, 10000);

    // position over the table, will be animated to the final camera position
    this.camera.position.x = 0;
    this.camera.position.y = 1.6;
    this.camera.position.z = 0.6;
  }

  setupLights() {
    this.light = new DirectionalLight(0xffffff, 0.3, 0);
    this.light.position.z = this.config.tablePositionZ;
    this.light.position.z = 2;
    this.light.position.y = 4;
    this.light.shadow.camera.near = 3.5;
    this.light.shadow.camera.far = 5.4;
    this.light.shadow.camera.left = -this.config.tableWidth / 2;
    this.light.shadow.camera.right = this.config.tableWidth / 2;
    this.light.shadow.camera.bottom = 0.8;
    this.light.shadow.camera.top = 3.4;
    this.light.castShadow = true;
    this.light.shadow.mapSize.width = (this.isMobile ? 1 : 8) * 512;
    this.light.shadow.mapSize.height = (this.isMobile ? 1 : 8) * 512;
    this.scene.add(this.light);

    this.scene.add(new AmbientLight(0xFFFFFF, 0.9));
  }

  setupTablePlane() {
    this.raycaster = new Raycaster();
    const geometry = new PlaneGeometry(40, 40, 5, 5);
    const material = new MeshBasicMaterial({color: 0xffff00, wireframe: true});
    this.tablePlane = new Mesh(geometry, material);
    this.tablePlane.rotation.x = -Math.PI * 0.45;
    this.tablePlane.position.y = this.config.tableHeight + 0.2;
    this.tablePlane.position.z = this.config.tablePositionZ + this.config.tableDepth / 2;
    this.tablePlane.material.visible = false;
    this.scene.add(this.tablePlane);
  }

  setupControllers() {
    navigator.getVRDisplays().then(displays => {
      if (displays.length > 0) {
        this.display = displays[0];
        if (displays[0].capabilities && displays[0].capabilities.hasPosition) {
          // also check gamepads
          this.controller1 = new ViveController(0);
          this.controller1.standingMatrix = this.controls.getStandingMatrix();
          this.scene.add(this.controller1);
          this.controller2 = new ViveController(1);
          this.controller2.standingMatrix = this.controls.getStandingMatrix();
          this.scene.add(this.controller2);

          this.objLoader.load('vr_controller_vive_1_5.obj', object => {
            const controller = object.children[0];
            controller.material.map = this.textureLoader.load('onepointfive_texture.png');
            controller.material.specularMap = this.textureLoader.load('onepointfive_spec.png');

            this.controller1.add(object.clone());
            this.controller2.add(object.clone());
          });
        }
      }
    });
  }

  setupEffects() {
    let geometry = new SphereGeometry(0.3, 32, 32);
    let material = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.halo = new Mesh(geometry, material);
    this.halo.position.z = 10;
    this.scene.add(this.halo);

    this.ballPath = new CatmullRomCurve3([new Vector3(0, 0, 0), new Vector3(0, 0.1, 0)]);
    geometry = new TubeGeometry(this.ballPath, 30, 0.01, 8, false);

    // create a gradient texture on canvas and apply it on material
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    const gradient = ctx.createLinearGradient(0, 0, 200, 0);
    gradient.addColorStop(0, 'rgba(249, 252, 86, 0)');
    gradient.addColorStop(1, 'rgba(249, 252, 86, 0.3)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 512);
    const trailTexture = new Texture(canvas);
    trailTexture.needsUpdate = true;

    material = new MeshBasicMaterial({
      map: trailTexture,
      transparent: true,
    });
    this.trail = new Mesh(geometry, material);
    this.scene.add(this.trail);
    this.ballPath = null;
  }

  startGame() {
    // prepare the scene
    this.hud.container.visible = false;
    const table = this.scene.getObjectByName('table');
    if (this.config.mode === MODE.MULTIPLAYER) {
      if (this.communication.isHost) {
        this.renderer.setClearColor(this.config.colors.BLUE_CLEARCOLOR, 1);
        table.material.color.set(this.config.colors.BLUE_TABLE);
      } else {
        this.renderer.setClearColor(this.config.colors.GREEN_CLEARCOLOR, 1);
        table.material.color.set(this.config.colors.GREEN_TABLE);
      }
    } else {
      const upwardsTableGroup = this.scene.getObjectByName('upwardsTableGroup');
      upwardsTableGroup.visible = true;
      this.net.visible = false;
      this.physics.net.collisionResponse = 0;
      this.physics.upwardsTable.collisionResponse = 1;
      this.renderer.setClearColor(this.config.colors.PINK_CLEARCOLOR, 1);
      table.material.color.set(this.config.colors.PINK_TABLE);
    }

    this.introPanAnimation().then(() => {
      this.viewport = {
        width: $(this.renderer.domElement).width(),
        height: $(this.renderer.domElement).height(),
      };
      if (this.display) {
        this.display.resetPose();
      }
      this.paddle.visible = true;
      this.hud.container.visible = true;
      this.setupVRControls();
      if (this.config.mode === MODE.SINGLEPLAYER) {
        this.countdown();
      } else {
        this.paddleOpponent.visible = true;
        this.playerRequestedCountdown = true;
        this.communication.sendRequestCountdown();
        this.requestCountdown();
      }
    });
  }

  introPanAnimation() {
    this.animate();
    return new Promise(resolve => {
      const tl = new TimelineMax();
      this.camera.lookAt(
        new Vector3().lerpVectors(
          this.ghostPaddlePosition,
          new Vector3(
            this.table.position.x,
            this.config.tableHeight + 0.3,
            this.table.position.z
          ),
          0.5
        )
      );
      this.camera.position.y = 5;
      tl.set(this.renderer.domElement, {display: 'block'});

      if (this.config.mode === MODE.MULTIPLAYER && !this.isMobile && this.controlMode === CONTROLMODE.MOUSE) {
        tl.staggerTo([
          '.present-players',
          '#generated-room-code, #generated-room-url, #room-code',
          '.grey-text',
          '.opponent-joined',
        ], 0.5, {
          y: -20,
          opacity: 0,
        }, 0.1, 0);
      }
      tl.to('.intro-wrapper', 0.3, {autoAlpha: 0});

      const panDuration = 1.5;

      tl.to(this.camera.position, panDuration, {
        y: 1.6,
        ease: Power1.easeInOut,
      }, 0.6);
      tl.call(resolve, [], null, '+=1');
    });
  }

  requestCountdown() {
    if (this.playerRequestedCountdown && this.opponentRequestedCountdown) {
      this.countdown();
    }
  }

  countdown() {
    // TODO why is this neccessary
    $('.opponent-joined').css('display', 'none');
    this.paddle.visible = true;
    this.paddleOpponent.visible = this.config.mode === MODE.MULTIPLAYER;
    this.sound.playLoop('bass');
    this.hud.scoreDisplay.show();
    this.hud.message.hideMessage(this.config.mode === MODE.MULTIPLAYER);
    setTransparency(this.table, 1);
    setTransparency(this.net, 1);

    this.config.state = STATE.COUNTDOWN;
    // countdown from 3, start game afterwards
    this.hud.countdown.showCountdown();
    let n = 2;
    const countdown = this.time.setInterval(() => {
      this.hud.countdown.setCountdown(n);
      n -= 1;
      if (n < 0) {
        // stop the countdown
        this.time.clearInterval(countdown);
        this.hud.countdown.hideCountdown();
        // start game by adding ball
        if (this.config.mode === MODE.SINGLEPLAYER) {
          this.addBall();
          this.physics.initBallPosition();
        } else if (this.config.mode === MODE.MULTIPLAYER
            && !this.communication.isHost) {
          this.addBall();
          // if multiplayer, also send the other player a hit so the ball is synced
          this.communication.sendMiss({
            x: this.physics.ball.position.x,
            y: this.physics.ball.position.y,
            z: this.physics.ball.position.z,
          }, {
            x: this.physics.ball.velocity.x,
            y: this.physics.ball.velocity.y,
            z: this.physics.ball.velocity.z,
          }, true, true);
        }
      }
    }, 1000);
  }

  restartGame() {
    this.crosshair.visible = false;
    this.physics.speed = 1;
    this.resetScore();
    if (this.config.mode === MODE.SINGLEPLAYER) {
      this.countdown();
      this.emitter.emit(EVENT.RESTART_GAME, this.score);
      return;
    }

    // only restart if both players requested it
    if (this.opponentRequestedRestart && this.playerRequestedRestart) {
      this.emitter.emit(EVENT.RESTART_GAME, this.score);
      // reset
      this.playerRequestedRestart = false;
      this.opponentRequestedRestart = false;
      this.countdown();
    }
  }

  resetScore() {
    this.score.self = 0;
    this.score.opponent = 0;
    this.score.highest = 0;
    this.score.lives = this.config.startLives;
    // propagate to HUD
    this.hud.scoreDisplay.setSelfScore(0);
    this.hud.scoreDisplay.setOpponentScore(0);
    this.hud.scoreDisplay.setLives(this.score.lives);
  }

  setMultiplayer() {
    // prepare multiplayer mode
    this.config.mode = MODE.MULTIPLAYER;
    this.scene.remove(this.table);
    this.table = Table(this.scene, this.config);
    this.hud.message.showMessage();
    this.resetTimeoutDuration = 3000;
    this.hud.scoreDisplay.opponentScore.visible = true;
    this.hud.scoreDisplay.lifeGroup.visible = false;
    this.scene.getObjectByName('net-collider').visible = true;
    // add callbacks for received actions
    this.communication.setCallbacks({
      receivedMove: this.onReceivedMove.bind(this),
      receivedHit: this.onReceivedHit.bind(this),
      receivedMiss: this.onReceivedMiss.bind(this),
      receivedRestartGame: this.onReceivedRestartGame.bind(this),
      receivedRequestCountdown: this.onReceivedRequestCountdown.bind(this),
    });
  }

  setSingleplayer() {
    // prepare singleplayer mode
    this.config.mode = MODE.SINGLEPLAYER;
    this.scene.remove(this.table);
    this.table = Table(this.scene, this.config);
    this.hud.message.hideMessage();
    this.resetTimeoutDuration = 1500;
    this.hud.scoreDisplay.opponentScore.visible = false;
    this.hud.scoreDisplay.lifeGroup.visible = true;
    this.scene.getObjectByName('net-collider').visible = false;
  }

  onReceivedMove(move) {
    // received a move from the opponent,
    // set his paddle to the position received
    const pos = mirrorPosition(move.position, this.config.tablePositionZ);
    const no = {
      x: this.paddleOpponent.position.x,
      y: this.paddleOpponent.position.y,
      z: this.paddleOpponent.position.z,
      rotationX: this.paddleOpponent.rotation.x,
      rotationY: this.paddleOpponent.rotation.y,
      rotationZ: this.paddleOpponent.rotation.z,
    };
    // show the opponent paddle slightly behind
    // the actual position to prevent the ball going
    // 'through' it
    TweenMax.to(no, 0.14, {
      x: pos.x,
      y: pos.y,
      z: pos.z - 0.1,
      // eslint-disable-next-line
      rotationX: -move.rotation._x,
      // eslint-disable-next-line
      rotationY: move.rotation._y,
      // eslint-disable-next-line
      rotationZ: -move.rotation._z,
      onUpdate: () => {
        this.paddleOpponent.position.x = no.x;
        this.paddleOpponent.position.y = no.y;
        this.paddleOpponent.position.z = no.z;
        this.paddleOpponent.rotation.x = no.rotationX;
        this.paddleOpponent.rotation.y = no.rotationY;
        this.paddleOpponent.rotation.z = no.rotationZ;
      },
    });
  }

  onReceivedRestartGame() {
    this.opponentRequestedRestart = true;
    // try to restart game, only does if player also requested restart
    this.restartGame();
  }

  onReceivedHit(data, wasMiss = false) {
    this.time.clearTimeout(this.resetBallTimeout);
    // we might not have a ball yet
    if (!this.ball) {
      // this doesnt add a ball if it already exists so were safe to call it
      this.addBall();
    } else {
      this.sound.paddle(data.point);
    }
    if (!wasMiss) {
      this.haloAnimation(mirrorPosition(data.point, this.config.tablePositionZ));
      // the received position will sometimes be slightly off from the position
      // of this players ball due to changes in latency. save the difference and
      // interpolate it until the ball is at our side again. this way the user
      // shouldnt notice any hard position changes
      this.ballPositionDifference = new Vector3().subVectors(
        this.physics.ball.position,
        mirrorPosition(data.point, this.config.tablePositionZ)
      );
      this.ballInterpolationAlpha = 1;
      TweenMax.to(this, 0.5, {
        ease: Power0.easeNone,
        ballInterpolationAlpha: 0,
      });
      this.physics.increaseSpeed();
    }
    this.physicsTimeStep = 1000;
    // received vectors are in the other users space
    // invert x and z velocity and mirror the point across the center of the table
    this.physics.ball.position.copy(mirrorPosition(data.point, this.config.tablePositionZ));
    this.physics.ball.velocity.copy(mirrorVelocity(data.velocity));
  }

  onReceivedMiss(data) {
    this.physics.speed = 1;
    this.ballPositionDifference = null;
    this.time.clearTimeout(this.resetBallTimeout);
    // opponent missed, update player score
    // and set game to be over if the score is high enough
    if (!data.isInit) {
      if (data.ballHasHitEnemyTable) {
        this.score.opponent += 1;
        this.hud.scoreDisplay.setOpponentScore(this.score.opponent);
        this.sound.playUI('miss');
      } else {
        this.score.self += 1;
        this.hud.scoreDisplay.setSelfScore(this.score.self);
        this.sound.playUI('point');
      }
    } else {
      this.addBall();
    }
    if (this.score.self >= this.config.POINTS_FOR_WIN
      || this.score.opponent >= this.config.POINTS_FOR_WIN) {
      this.emitter.emit(EVENT.GAME_OVER, this.score, this.config.mode);
    } else {
      this.physics.ball.angularVelocity.x = 0;
      this.physics.ball.angularVelocity.y = 0;
      this.physics.ball.angularVelocity.z = 0;
      // otherwise, the opponent that missed also resets the ball
      // and sends along its new position
      this.onReceivedHit(data, true);
      this.config.state = STATE.PLAYING;
    }
  }

  onReceivedRequestCountdown() {
    this.opponentRequestedCountdown = true;
    this.requestCountdown();
  }

  slowdownBall() {
    // if the ball is on the way to the opponent,
    // we slow it down so it will be on the opponents side
    // approximately at the time they actually hit it
    // NOTE that we still only receive the hit half a roundtriptime later
    if (this.physics.ball.velocity.z > 0) {
      return;
    }
    const velocity = this.physics.ball.velocity.length();
    const dist = new Vector3().subVectors(this.ball.position, this.paddleOpponent.position).length();
    const eta = dist / velocity;
    const desirableEta = eta + (this.communication.latency / 1000);
    this.physicsTimeStep = 1000 * (desirableEta / eta) * 1;
  }

  restartPingpongTimeout() {
    // reset the ball position in case the ball is stuck at the net
    // or fallen to the floor
    this.time.clearTimeout(this.resetBallTimeout);
    if (this.config.state === STATE.GAME_OVER) {
      return;
    }
    this.resetBallTimeout = this.time.setTimeout(this.resetTimeoutEnded.bind(this), this.resetTimeoutDuration);
  }

  resetTimeoutEnded() {
    this.ballPath = null;
    if (this.config.mode === MODE.MULTIPLAYER) {
      this.physicsTimeStep = 1000;
      if (this.ballHasHitEnemyTable) {
        this.score.self += 1;
        this.hud.scoreDisplay.setSelfScore(this.score.self);
        this.sound.playUI('point');
      } else {
        this.score.opponent += 1;
        this.hud.scoreDisplay.setOpponentScore(this.score.opponent);
        this.sound.playUI('miss');
      }
      if (this.score.opponent >= this.config.POINTS_FOR_WIN
          || this.score.self >= this.config.POINTS_FOR_WIN) {
        // game is over
        // TODO maybe wait a little with this so players can enjoy their 11 points
        this.emitter.emit(EVENT.GAME_OVER, this.score, this.config.mode);
      } else {
        // the game goes on
        this.physics.initBallPosition();
      }

      this.communication.sendMiss({
        x: this.physics.ball.position.x,
        y: this.physics.ball.position.y,
        z: this.physics.ball.position.z,
      }, {
        x: this.physics.ball.velocity.x,
        y: this.physics.ball.velocity.y,
        z: this.physics.ball.velocity.z,
      }, this.ballHasHitEnemyTable);
      this.ballHasHitEnemyTable = false;
    } else {
      // singleplayer
      this.score.highest = Math.max(this.score.self, this.score.highest);
      this.score.self = 0;
      this.hud.scoreDisplay.setSelfScore(this.score.self);
      this.physics.initBallPosition();
      this.score.lives -= 1;
      this.hud.scoreDisplay.setLives(this.score.lives);
      this.sound.playUI('miss');
      if (this.score.lives < 1) {
        this.emitter.emit(EVENT.GAME_OVER, this.score, this.config.mode);
      }
    }
    this.restartPingpongTimeout();
  }

  addBall() {
    this.config.state = STATE.PLAYING;
    if (this.ball) {
      this.ball.visible = true;
      this.physics.initBallPosition();
      this.restartPingpongTimeout();
      return;
    }
    this.ball = new Ball(this.scene, this.config);
    this.physics.addBall();
    this.restartPingpongTimeout();
  }

  updateControls() {
    if (this.controller1 && this.controller2) {
      this.controller1.update();
      this.controller2.update();
    }
    const pos = this.computePaddlePosition();
    if (pos) {
      this.ghostPaddlePosition.copy(pos);
    }
    if (this.controls && this.controlMode === CONTROLMODE.VR) {
      // Update VR headset position and apply to camera.
      this.controls.update();
      if (this.camera.position.x === 0
        && this.camera.position.z === 0) {
          // no position sensor in the device, put it behind the table
        this.camera.position.z = 1;
      }
    }
    if (this.hitTween && this.hitTween.isActive()) {
      // interpolate between ball and paddle position during hit animation
      const newPos = new Vector3().lerpVectors(
        pos,
        this.lastHitPosition,
        this.paddleInterpolationAlpha
      );
      this.paddle.position.copy(newPos);
    } else if (pos) {
      this.paddle.position.copy(pos);
    }
    const rotation = this.computePaddleRotation(this.paddle.position);
    this.paddle.rotation.x = rotation.x;
    this.paddle.rotation.z = rotation.z;
    this.updateCamera();
  }

  updateCamera() {
    if (this.display && this.controlMode !== CONTROLMODE.MOUSE) {
      // user controls camera with headset in vr mode
      return;
    }
    // backup original rotation
    const startRotation = new Euler().copy(this.camera.rotation);

    // look at the point at the middle position between the table center and paddle
    this.camera.lookAt(
      new Vector3().lerpVectors(
        this.ghostPaddlePosition,
        new Vector3(
          this.table.position.x,
          this.config.tableHeight + 0.3,
          this.table.position.z
        ),
        0.5
      )
    );
    // the rotation we want to end up with
    const endRotation = new Euler().copy(this.camera.rotation);
    // revert to original rotation and then we can tween it
    this.camera.rotation.copy(startRotation);
    if (this.cameraTween) {
      this.cameraTween.kill();
    }
    this.cameraTween = TweenMax.to(this.camera.rotation, 0.5, {
      x: endRotation.x,
      y: endRotation.y,
      z: endRotation.z,
      ease: Power4.easeOut,
    });
  }

  computePaddlePosition() {
    let paddlePosition = null;
    if (this.display && this.controlMode === CONTROLMODE.VR) {
      let controller = null;
      if (this.controller1 && this.controller1.visible) {
        controller = this.controller1;
      } else if (this.controller2 && this.controller2.visible) {
        controller = this.controller2;
      }
      let intersects = [];
      if (controller) {
        // VIVE ETC
        // if we do have a controller, intersect the table with where the controller is facing
        const direction = new Vector3(0, 0, -1);
        direction.applyQuaternion(controller.getWorldQuaternion());
        direction.normalize();
        this.raycaster.set(controller.getWorldPosition(), direction);
        this.raycaster.far = 5;
        intersects = this.raycaster.intersectObject(this.tablePlane, false);
      } else {
        // CARDBOARD
        // if we dont have a controller, intersect the table
        // with where the camera is looking and place the paddle there
        // if we are in vr, position paddle below looking direction so we dont have
        // to look down at all times
        const rayYDirection = this.manager.mode === VR_MODES.VR ? -0.7 : -0.3;
        this.raycaster.setFromCamera(new Vector2(0, rayYDirection), this.camera);
        this.raycaster.far = 5;
        intersects = this.raycaster.intersectObject(this.tablePlane, false);
        if (intersects.length > 0) {
          intersects[0].point.x *= 1.5;
        }
      }
      if (intersects.length > 0) {
        paddlePosition = intersects[0].point;
      }
    } else if (this.pointerIsLocked) {
      // MOUSE
      paddlePosition = {
        x: this.ghostPaddlePosition.x + 0.0015 * this.mouseMoveSinceLastFrame.x,
        y: this.config.tableHeight + 0.24,
        z: this.ghostPaddlePosition.z + 0.0015 * this.mouseMoveSinceLastFrame.y,
      };
    } else {
      paddlePosition = {
        x: 1.4 * this.mousePosition.x * this.config.tableWidth,
        y: this.config.tableHeight + 0.24,
        z: -this.config.tableDepth * 0.5 * (this.mousePosition.y + 0.5),
      };
    }
    if (paddlePosition) {
      const x = cap(paddlePosition.x, this.config.tableWidth, -this.config.tableWidth);
      const z = cap(paddlePosition.z, this.config.tablePositionZ + 0.5, 0);
      const y = paddlePosition.y || this.config.tableHeight + 0.1 - z * 0.2;
      return {x, y, z};
    }
    return this.paddle.position.clone();
  }

  computePaddleRotation(pos) {
    return {
      x: -((this.config.tablePositionZ + this.config.tableDepth / 2) - pos.z * 1),
      y: 0,
      z: cap(-pos.x, -Math.PI / 2, Math.PI / 2),
    };
  }

  updateBall() {
    if (this.ballPositionDifference) {
      // we interpolate between the actual (received) position and the position
      // the user would expect. after 500ms both positions are the same.
      const fauxPosition = new Vector3().lerpVectors(
        this.physics.ball.position,
        new Vector3().addVectors(
          this.physics.ball.position,
          this.ballPositionDifference
        ),
        this.ballInterpolationAlpha
      );
      this.ball.position.copy(fauxPosition);
      this.ball.quaternion.copy(this.physics.ball.quaternion);
    } else {
      this.ball.position.copy(this.physics.ball.position);
      this.ball.quaternion.copy(this.physics.ball.quaternion);
    }
  }

  ballHitAnimation() {
    if (!(this.hitTween && this.hitTween.isActive()) && this.hitAvailable) {
      this.hitAvailable = false;
      this.hitTween = new TimelineMax({
        onComplete: () => {this.hitAvailable = true;},
      });
      this.lastHitPosition = this.ball.position.clone();
      this.lastHitPosition.y = Math.max(this.lastHitPosition.y, this.config.tableHeight + 0.2);
      this.hitTween.to(this, 0.05, {
        paddleInterpolationAlpha: 1,
        ease: Power2.easeIn,
      });
      this.hitTween.to(this, 0.4, {
        ease: Power2.easeOut,
        paddleInterpolationAlpha: 0,
      });
    }
  }

  haloAnimation(position) {
    this.halo.position.copy(position);
    TweenMax.fromTo(this.halo.material, 1, {
      opacity: 0.2,
    }, {
      opacity: 0,
    });
    TweenMax.fromTo(this.halo.scale, 1, {
      x: 0.001,
      y: 0.001,
      z: 0.001,
    }, {
      x: 1,
      y: 1,
      z: 1,
      ease: Expo.easeOut,
    });
  }

  updateHudControls() {
    // raycaster wants mouse from -1 to 1, not -0.5 to 0.5 like mousePosition is normalized
    let mouse = {};
    if (this.controlMode === CONTROLMODE.VR || this.isMobile) {
      const zCamVec = new Vector3(0, 0, -1);
      const position = this.camera.localToWorld(zCamVec);
      this.crosshair.position.set(position.x, position.y, position.z);
      mouse = {
        x: 0,
        y: 0,
      };
    } else {
      mouse = {
        x: this.mousePosition.x * 2,
        y: this.mousePosition.y * 2,
      };
    }
    this.raycaster.setFromCamera(mouse, this.camera);
    this.hud.message.intersect(this.raycaster, this.controlMode === CONTROLMODE.MOUSE && !this.isMobile);
  }

  animate() {
    const timestamp = Date.now();
    const delta = Math.min(timestamp - this.lastRender, 500);
    this.fps.tick();

    if (this.ball) {
      const dist = new Vector3();
      dist.subVectors(this.ball.position, this.paddle.position);
      if (
        // ball is close enough to the paddle for a hit
        (dist.length() < 0.4
          && Math.abs(dist.x) < 0.2
          && Math.abs(dist.z) < 0.1
        || this.isMobile && dist.length() < 0.8
          && Math.abs(dist.x) < 0.3
          && Math.abs(dist.z) < 0.1)
        // and ball is moving towards us, it could move away from us
        // immediately after the opponent reset the ball and it that case
        // we wouldnt want a hit
        && this.physics.ball.velocity.z > 0) {
        this.onBallPaddleCollision(this.ball.position);
      }

      // the points array is a first in first out queue
      if (!this.ballPath) {
        this.ballPath = new CatmullRomCurve3([
          this.ball.position.clone(),
          new Vector3(
            this.ball.position.x,
            this.ball.position.y,
            this.ball.position.z + 0.001
          ),
        ]);
      } else {
        this.ballPath.points.push(this.ball.position.clone());
      }
      if (this.ballPath.points.length > 50) {
        this.ballPath.points.shift();
      }
      this.trail.geometry.dispose();
      this.trail.geometry = new TubeGeometry(this.ballPath, 128, 0.01, 8, false);
    }


    if (this.config.state === STATE.PLAYING
      || this.config.state === STATE.COUNTDOWN
      || this.config.state === STATE.GAME_OVER) {
      this.updateControls();
      if (this.ball && this.config.mode === MODE.MULTIPLAYER && !this.communication.isHost) {
        // for multiplayer testing
        // this.paddle.position.y = Math.max(this.config.tableHeight + 0.1, this.ball.position.y);
        // this.paddle.position.x = this.ball.position.x;
      }
      if (this.config.mode === MODE.MULTIPLAYER) {
        // send where the paddle has moved, if it has moved
        // every 5th frame is enough, this way we send less bytes down the line
        if (this.frameNumber % 5 === 0) {
          this.communication.sendMove(
            this.paddle.position,
            this.paddle.rotation
          );
        }
      }
    }

    if (this.config.state === STATE.PLAYING) {
      this.physics.step(delta / this.physicsTimeStep);
      this.updateBall();
      this.physics.predictCollisions(this.scene.getObjectByName('net-collider'), delta);
    }

    if (this.config.state === STATE.GAME_OVER) {
      this.updateHudControls();
    }

    if (DEBUG_MODE) {
      this.physicsDebugRenderer.update();
    }

    this.time.step();

    this.lastRender = timestamp;
    this.frameNumber += 1;
    this.mouseMoveSinceLastFrame.x = 0;
    this.mouseMoveSinceLastFrame.y = 0;

    // render the scene through the manager.
    this.manager.render(this.scene, this.camera, this.timestamp);
    if (this.display && 'requestAnimationFrame' in this.display && this.controlMode === CONTROLMODE.VR) {
      this.display.requestAnimationFrame(this.animate.bind(this));
    } else {
      requestAnimationFrame(this.animate.bind(this));
    }
  }
}
