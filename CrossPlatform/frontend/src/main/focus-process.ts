import { spawn } from 'node:child_process'

/**
 * dnSpy's SwitchToDebuggedProcess: SetForegroundWindow on the debugged process's main window. Linux has no such
 * call. An X11 session lets one client activate another's window through EWMH, which xdotool speaks, so the
 * window is raised with it when it is installed; a Wayland compositor lets no client do it, and then nothing
 * happens. Answers whether a window was activated.
 */
export const focusProcessWindow = (processId: number, env: NodeJS.ProcessEnv = process.env): Promise<boolean> => {
  if (process.platform !== 'linux' || !Number.isInteger(processId) || processId <= 0 || !env.DISPLAY)
    return Promise.resolve(false)
  return new Promise((resolve) => {
    try {
      const child = spawn('xdotool', ['search', '--onlyvisible', '--limit', '1', '--pid', String(processId), 'windowactivate'], { stdio: 'ignore', env })
      const timer = setTimeout(() => { child.kill(); resolve(false) }, 2000)
      child.on('error', () => { clearTimeout(timer); resolve(false) })
      child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0) })
    } catch {
      resolve(false)
    }
  })
}
