# Try a pipeline (rnaseq) from the user's view

Three ways, fastest first. Open AppHub -> Pipelines.

## 1. Hello (smoke test) — seconds
Pick "Hello (smoke test)" -> Launch. Confirms the whole path works (no parameters, no containers).

## 2. Real rnaseq with zero setup — recommended for a short test
Pipelines -> "Import config" -> choose `rnaseq-test.apphub-pipeline.json` (in this folder).
It prefills the form for nf-core/rnaseq with the built-in `test` profile (tiny data that
nf-core provides). Click "Launch run".
- First run takes ~10-15 min (it pulls the Singularity containers once; later runs are fast).
- Results appear under `pipeline-examples/rnaseq/results` in your files; the run also writes
  report.html / timeline.html / trace.txt in its run folder. Track it on the Dashboard + Job queue.

## 3. Your own data
Select nf-core/rnaseq, then in the form:
- Input: a samplesheet.csv like the example here (columns: sample, fastq_1, fastq_2, strandedness).
  Put your FASTQs under `pipeline-examples/rnaseq/data/` and update the paths.
- Genome: choose e.g. GRCh38, or set fasta + gtf under advanced parameters.
- Resources: set CPU / memory / runtime for your data size.
- (Optional) upload `custom.config` to override per-process resources.

## Reuse a config (export / import)
Any run's form can be saved with "Export" (downloads a .json) and reloaded later with
"Import config" to prefill everything. `rnaseq-test.apphub-pipeline.json` is exactly such a file.
The `params` block inside it is also a valid Nextflow `-params-file`.
