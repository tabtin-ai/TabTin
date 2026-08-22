from django.db import migrations, models


def backfill_import_job_context(apps, schema_editor):
    db_alias = schema_editor.connection.alias
    DocumentImportJob = apps.get_model('docparse', 'DocumentImportJob')

    jobs = (
        DocumentImportJob.objects.using(db_alias)
        .select_related('file_record')
        .all()
        .iterator(chunk_size=500)
    )
    for job in jobs:
        result_payload = job.result_payload if isinstance(job.result_payload, dict) else {}
        request_payload = job.request_payload if isinstance(job.request_payload, dict) else {}
        legacy_request = result_payload.get('request') if isinstance(result_payload.get('request'), dict) else {}
        request = request_payload or legacy_request

        organization_id = str(
            request.get('organization_id')
            or getattr(job.file_record, 'organization_id', '')
            or ''
        )
        space_id = str(request.get('space_id') or '')
        file_record_id = str(request.get('file_record_id') or job.file_record_id)
        requested_by_id = str(request.get('user_id') or '')

        normalized_request = {
            'organization_id': organization_id,
            'space_id': space_id,
            'file_record_id': file_record_id,
            'user_id': requested_by_id,
        }
        sanitized_result_payload = dict(result_payload)
        sanitized_result_payload.pop('request', None)
        DocumentImportJob.objects.using(db_alias).filter(pk=job.pk).update(
            organization_id=organization_id,
            space_id=space_id,
            requested_by_id=requested_by_id,
            request_payload=normalized_request,
            result_payload=sanitized_result_payload,
        )


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [
        ('docparse', '0003_document_import_job_constraints'),
    ]

    operations = [
        migrations.AddField(
            model_name='documentimportjob',
            name='organization_id',
            field=models.CharField(blank=True, db_index=True, default='', max_length=100),
        ),
        migrations.AddField(
            model_name='documentimportjob',
            name='space_id',
            field=models.CharField(blank=True, db_index=True, default='', max_length=100),
        ),
        migrations.AddField(
            model_name='documentimportjob',
            name='requested_by_id',
            field=models.CharField(blank=True, db_index=True, default='', max_length=100),
        ),
        migrations.AddField(
            model_name='documentimportjob',
            name='request_payload',
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.RunPython(backfill_import_job_context, noop_reverse),
        migrations.RemoveConstraint(
            model_name='documentimportjob',
            name='docparse_import_job_one_active_per_file',
        ),
        migrations.RemoveIndex(
            model_name='documentimportjob',
            name='services_do_celery__de136e_idx',
        ),
        migrations.AddIndex(
            model_name='documentimportjob',
            index=models.Index(
                fields=['organization_id', 'space_id', 'status'],
                name='services_do_organiz_0e0faa_idx',
            ),
        ),
        migrations.AddConstraint(
            model_name='documentimportjob',
            constraint=models.UniqueConstraint(
                condition=models.Q(('status__in', ('queued', 'running', 'retrying'))),
                fields=('file_record', 'organization_id', 'space_id'),
                name='docparse_import_job_one_active_per_context',
            ),
        ),
    ]
