import { useAppStore } from '../app-store'

export const OutputPane = (): React.JSX.Element => {
  const output = useAppStore((state) => state.output)
  return (
    <div className="output-pane" role="log">
      {output.map((line, index) => <div key={`${index}:${line}`}>{line}</div>)}
    </div>
  )
}

export const DebugPlaceholder = ({ label }: { label: string }): React.JSX.Element => (
  <div className="pane-empty">{label}</div>
)
