 #!/bin/bash
gcloud functions deploy create-first-driver-move \
--gen2 \
--env-vars-file .env.yaml \
--region=us-central1 \
--entry-point=create_driver_moves_cf \
--trigger-http \
--runtime nodejs12 \
--project robotransport \
--allow-unauthenticated
