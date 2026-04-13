import { SearchAttributeType, defineSearchAttributeKey } from '@temporalio/common'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import {
  SYNC_ENGINE_PIPELINE_DESIRED_STATUS_SEARCH_ATTRIBUTE,
  SYNC_ENGINE_PIPELINE_STATUS_SEARCH_ATTRIBUTE,
} from '../temporal/pipeline-search-attributes.js'

/** Local dev server with the custom search attributes used by `pipelineWorkflow`. */
export function createPipelineTestWorkflowEnvironment() {
  return TestWorkflowEnvironment.createLocal({
    server: {
      searchAttributes: [
        defineSearchAttributeKey(
          SYNC_ENGINE_PIPELINE_STATUS_SEARCH_ATTRIBUTE,
          SearchAttributeType.KEYWORD
        ),
        defineSearchAttributeKey(
          SYNC_ENGINE_PIPELINE_DESIRED_STATUS_SEARCH_ATTRIBUTE,
          SearchAttributeType.KEYWORD
        ),
      ],
    },
  })
}
