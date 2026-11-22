import { useEffect, useRef, useState } from 'react'
import { getErrorMessage } from '../../services/errors.js'

export async function applyToFiles(files, action, signal) {
  const succeeded = []
  const failures = []
  for (const file of files) {
    if (signal?.aborted) break
    try {
      await action(file, signal)
      succeeded.push(file)
    } catch (error) {
      failures.push({ file, message: getErrorMessage(error) })
    }
  }
  return { succeeded, failures }
}

export function useFileBatch(files) {
  const [state, setState] = useState(() => ({ remaining: files, completed: 0, failures: [] }))
  const [busy, setBusy] = useState(false)
  const running = useRef(null)

  useEffect(() => () => running.current?.abort(), [])

  async function apply(action) {
    if (running.current) return null
    const controller = new AbortController()
    running.current = controller
    setBusy(true)
    try {
      const result = await applyToFiles(state.remaining, action, controller.signal)
      if (controller.signal.aborted) return null
      setState({
        remaining: result.failures.map(({ file }) => file),
        completed: state.completed + result.succeeded.length,
        failures: result.failures,
      })
      return result
    } finally {
      running.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return { ...state, busy, apply }
}
