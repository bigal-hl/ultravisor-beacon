# Shell Provider

Execute shell commands on the beacon worker via `child_process.exec()`.

**Capability:** `Shell`

## Configuration

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `MaxBufferBytes` | `number` | `10485760` (10 MB) | Maximum stdout/stderr buffer size |

```javascript
{ Source: 'Shell', Config: { MaxBufferBytes: 20971520 } }
```

## Actions

### Execute

Run a shell command with optional parameters.

#### Settings

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `Command` | `string` | Yes | The command to run |
| `Parameters` | `string` | No | Command-line arguments (appended to Command) |

#### Outputs

| Name | Type | Description |
|------|------|-------------|
| `StdOut` | `string` | Combined stdout and stderr (on error) or stdout (on success) |
| `ExitCode` | `number` | Process exit code (0 = success) |
| `Result` | `string` | Same as `StdOut` on success, empty on error |

#### Example Work Item

```javascript
{
	Capability: 'Shell',
	Action: 'Execute',
	Settings:
	{
		Command: 'echo',
		Parameters: 'hello world'
	},
	TimeoutMs: 30000
}
```

#### Example Result

```javascript
{
	Outputs:
	{
		StdOut: 'hello world\n',
		ExitCode: 0,
		Result: 'hello world\n'
	},
	Log: ['Command executed: echo hello world']
}
```

## File Transfer Integration

The Shell provider works smoothly with the Executor's file transfer pipeline. Use `{SourcePath}` and `{OutputPath}` placeholders in the command:

```javascript
{
	Capability: 'Shell',
	Action: 'Execute',
	Settings:
	{
		Command: 'convert {SourcePath} -resize 800x600 {OutputPath}',
		SourceURL: 'http://files.example.com/photo.jpg',
		SourceFilename: 'photo.jpg',
		OutputFilename: 'resized.jpg',
		ReturnOutputAsBase64: true,
		AffinityKey: 'photos-batch-1'
	}
}
```

The Executor downloads the source file, substitutes the paths, runs the command, and collects the output file -- all transparently.

## Notes

- The command runs in the beacon's `StagingPath` working directory.
- `TimeoutMs` on the work item controls the execution timeout (default: 5 minutes).
- If the command fails, `ExitCode` is set to the process exit code and `StdOut` contains both stdout and stderr.
- Empty commands return `ExitCode: -1` without executing.
