import { Game } from './Game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(canvas, document.body);
game.start();

declare global {
  interface Window {
    game: Game;
  }
}
// Exposed for scripted verification and console poking.
window.game = game;
