// A service was asked about a pipeline that does not exist; an API route answers 404.
export class PipelineNotFoundError extends Error {
    constructor() {
        super('Pipeline not found');
        this.name = 'PipelineNotFoundError';
    }
}
