# Bunryu

A self-hosted restreaming server for long live events. Encoders publish live inputs to it, and it forwards each one to any number of destinations. This is the language of the product, the dashboard and the docs.

## Inputs

**Pipeline**:
One live input and the outputs that forward it, managed as a unit. It is created with a stream key.
_Avoid_: stream, channel, feed

**Stream key**:
The secret, prefixed `keyNN_`, that names the pipeline an encoder publishes to. The number of keys is fixed by a setting.
_Avoid_: publish key, token

**Publisher**:
The encoder currently sending to a pipeline's stream key.
_Avoid_: source, client, encoder (the device, not its connection)

**Direct SRT**:
An SRT input sent straight to SRS. It has no link statistics.
_Avoid_: plain SRT (when the relay is also in play)

**Relay input**:
An SRT input sent through the relay, with link statistics. It is either one link or a bonded group.
_Avoid_: SRT via relay, bonding input

**Relay**:
The separate process (goryu) that accepts relay inputs, merges a bonded group's links and forwards one SRT stream to SRS.
_Avoid_: bonding server, goryu (in the UI)

**Leg**:
One network link of a bonded group. A relay input that is not bonded is one link.
_Avoid_: path, connection (for a single bonded link)

**Preview**:
A live view of a pipeline's input in the dashboard. It copies the video and encodes only the audio.

## Outputs

**Output**:
One pipeline forwarded to one destination, by its own FFmpeg process, so outputs fail and recover independently.
_Avoid_: forward, stream, sink, target

**Destination**:
The `rtmp://`, `rtmps://` or `srt://` address an output pushes to.
_Avoid_: endpoint, sink

**Restream**:
An output whose destination is another pipeline on the same server.

**Encoding**:
What an output does to the input: video copy or one of the video profiles, and which audio is kept or re-encoded. Copy is the common case.
_Avoid_: profile (for the whole choice), transcode (for copy)

**Shared encode**:
One FFmpeg process that encodes once for the outputs of a pipeline that need the same encoding, which then forward the result in copy mode.
_Avoid_: rendition (the name of its rows in the code and the database)

**Desired state**:
Whether the operator wants an output running or stopped. It is saved, so running outputs start again after a restart or when the input returns.
_Avoid_: target state, enabled

**Status**:
What an output is doing now, as opposed to the state the operator wants.
_Avoid_: state (alone)

**History**:
An output's record of its starts, failures and recoveries, shown on its card. A repeated crash is one record.
_Avoid_: log (the pipeline log is a different thing)

## Health

**Alert**:
A condition the health poll raises on a pipeline, such as a lost leg or an input that keeps disconnecting. It ends after it has been quiet for a while.
_Avoid_: incident (that is a written fail report)

**Host alert**:
A resource condition of the whole machine: CPU busy or starved, memory or disk used. A warning from 70% and an error from 90%, worked out by the server; the dashboard shows each as a banner and colours the top bar from it.

**Resource usage**:
What the host and the three managed processes (this server, SRS and the relay) are using of CPU, RAM, disk and network, sampled on timers. The Overview's charts and System usage table and the diagnostics snapshot show the same samples.
_Avoid_: telemetry, metrics (only the API path keeps the word)

**Watchdog**:
A bounded loop that finds a stuck output and restarts it. Each one has a stated reason and a limit, so none can cause a restart storm.
_Avoid_: monitor, supervisor

**Verdict**:
The status of an input or output (good, warn, error or off) and the problems behind it, worked out by the server and shown by the dashboard and Key Vault. The dashboard works out no status of its own. On a pipeline's dot the input half also takes the relay's warning or error, even while the input is off.
_Avoid_: health (alone), state

**Advice**:
A hint about how an output or pipeline is configured, such as a destination another output also uses or audio settings that do not suit the input. The dashboard shows it as one yellow line on the output's card, and marks the output on the Status view and the Overview with a yellow outline round its dot and the lines in its tooltip and Issues cell; it is not part of a verdict, it is not a Problem, it never changes a status colour or count, and Key Vault never sees it.
_Avoid_: advisory warning

**Problem**:
An output or input with an error or a warning, as its dot colours it. An output stopped after repeated failures (its status stays off, its error is still current) is not one: it shows as a grey dot with a yellow outline, and its card shows the error as a yellow line. The Problems filter lists exactly the Problems.
_Avoid_: issue (that is a GitHub issue)

**Diagnostics**:
The rotated, structured, timestamped event records kept for explaining a failure afterwards.
_Avoid_: telemetry, metrics

## Organising

**Pipeline group**:
A collapsible section of the pipeline list that pipelines are assigned to.
_Avoid_: folder, category
