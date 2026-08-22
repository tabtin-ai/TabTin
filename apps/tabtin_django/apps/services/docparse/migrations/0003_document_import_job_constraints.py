import uuid

import json
from django.db import migrations, models
from django.db.models import Count
import django.db.models.deletion


_AUDIT_SAMPLE_LIMIT = 20


def _chunk_signature(chunk):
    metadata = chunk.metadata if isinstance(chunk.metadata, dict) else {}
    return (
        chunk.chunk_type or '',
        chunk.content or '',
        chunk.bbox_x0,
        chunk.bbox_y0,
        chunk.bbox_x1,
        chunk.bbox_y1,
        chunk.heading_level,
        json.dumps(metadata, ensure_ascii=False, sort_keys=True, default=str),
    )


def _page_keep_reason(page):
    return (
        'valid_chunks=%s text_chars=%s id=%s'
        % (getattr(page, 'chunk_count', 0), len(page.text_content or ''), page.id)
    )


def _append_sample(samples, value):
    if len(samples) < _AUDIT_SAMPLE_LIMIT:
        samples.append(value)


def clean_duplicate_docparse_rows(apps, schema_editor):
    """Audit and collapse legacy duplicates before adding unique constraints.

    Page keep rule:
      1. Prefer pages with valid chunks.
      2. Prefer the page with the most complete text_content.
      3. Tie-break by stable UUID order; page/parser updated_at is unavailable on
         DocumentPage, so the migration records that limitation instead of
         pretending it can use a freshness signal.

    Chunk keep rule:
      1. Exact duplicate chunks are safe to delete.
      2. Different content/metadata at the same sequence is audited and
         resequenced onto the kept page instead of being silently discarded.
    """
    db_alias = schema_editor.connection.alias
    DocumentPage = apps.get_model('docparse', 'DocumentPage')
    DocumentChunk = apps.get_model('docparse', 'DocumentChunk')
    audit = {
        'duplicate_page_groups': 0,
        'duplicate_chunk_groups': 0,
        'conflicting_content_groups': 0,
        'deleted_pages': 0,
        'deleted_chunks': 0,
        'moved_chunks': 0,
        'samples': [],
    }

    duplicate_pages = (
        DocumentPage.objects.using(db_alias)
        .values('document_id', 'page_number')
        .annotate(row_count=Count('id'))
        .filter(row_count__gt=1)
    )
    for group in duplicate_pages.iterator(chunk_size=200):
        pages = list(
            DocumentPage.objects.using(db_alias)
            .filter(
                document_id=group['document_id'],
                page_number=group['page_number'],
            )
            .annotate(chunk_count=Count('chunks'))
            .order_by('id')
        )
        if len(pages) <= 1:
            continue
        pages.sort(key=lambda page: (
            -getattr(page, 'chunk_count', 0),
            -len(page.text_content or ''),
            str(page.id),
        ))
        audit['duplicate_page_groups'] += 1
        keep = pages[0]
        keep_chunks = list(
            DocumentChunk.objects.using(db_alias)
            .filter(page_id=keep.id)
            .order_by('sequence', 'id')
        )
        keep_signatures = {_chunk_signature(chunk) for chunk in keep_chunks}
        used_sequences = {chunk.sequence for chunk in keep_chunks}
        next_sequence = (max(used_sequences) + 1) if used_sequences else 1
        _append_sample(audit['samples'], {
            'type': 'page',
            'document_id': str(group['document_id']),
            'page_number': group['page_number'],
            'keep_id': str(keep.id),
            'keep_reason': _page_keep_reason(keep),
            'discarded_page_ids': [str(page.id) for page in pages[1:]],
        })

        for duplicate in pages[1:]:
            loser_chunks = list(
                DocumentChunk.objects.using(db_alias)
                .filter(page_id=duplicate.id)
                .order_by('sequence', 'id')
            )
            for chunk in loser_chunks:
                signature = _chunk_signature(chunk)
                if signature in keep_signatures:
                    DocumentChunk.objects.using(db_alias).filter(id=chunk.id).delete()
                    audit['deleted_chunks'] += 1
                    continue
                target_sequence = chunk.sequence
                if target_sequence in used_sequences:
                    audit['conflicting_content_groups'] += 1
                    target_sequence = next_sequence
                    next_sequence += 1
                    _append_sample(audit['samples'], {
                        'type': 'page_chunk_conflict',
                        'from_page_id': str(duplicate.id),
                        'to_page_id': str(keep.id),
                        'chunk_id': str(chunk.id),
                        'old_sequence': chunk.sequence,
                        'new_sequence': target_sequence,
                    })
                DocumentChunk.objects.using(db_alias).filter(id=chunk.id).update(
                    page_id=keep.id,
                    sequence=target_sequence,
                )
                keep_signatures.add(signature)
                used_sequences.add(target_sequence)
                audit['moved_chunks'] += 1

            if not keep.text_content and duplicate.text_content:
                DocumentPage.objects.using(db_alias).filter(id=keep.id).update(
                    text_content=duplicate.text_content,
                )
                keep.text_content = duplicate.text_content
            DocumentPage.objects.using(db_alias).filter(id=duplicate.id).delete()
            audit['deleted_pages'] += 1

    duplicate_chunks = (
        DocumentChunk.objects.using(db_alias)
        .values('page_id', 'sequence')
        .annotate(row_count=Count('id'))
        .filter(row_count__gt=1)
    )
    for group in duplicate_chunks.iterator(chunk_size=500):
        chunks = list(
            DocumentChunk.objects.using(db_alias)
            .filter(page_id=group['page_id'], sequence=group['sequence'])
            .order_by('id')
        )
        if len(chunks) <= 1:
            continue
        audit['duplicate_chunk_groups'] += 1
        keep = chunks[0]
        keep_signature = _chunk_signature(keep)
        used_sequences = set(
            DocumentChunk.objects.using(db_alias)
            .filter(page_id=group['page_id'])
            .values_list('sequence', flat=True)
        )
        next_sequence = (max(used_sequences) + 1) if used_sequences else 1
        for chunk in chunks[1:]:
            if _chunk_signature(chunk) == keep_signature:
                DocumentChunk.objects.using(db_alias).filter(id=chunk.id).delete()
                audit['deleted_chunks'] += 1
                continue
            audit['conflicting_content_groups'] += 1
            while next_sequence in used_sequences:
                next_sequence += 1
            _append_sample(audit['samples'], {
                'type': 'chunk_sequence_conflict',
                'page_id': str(group['page_id']),
                'keep_id': str(keep.id),
                'chunk_id': str(chunk.id),
                'old_sequence': chunk.sequence,
                'new_sequence': next_sequence,
            })
            DocumentChunk.objects.using(db_alias).filter(id=chunk.id).update(
                sequence=next_sequence,
            )
            used_sequences.add(next_sequence)
            next_sequence += 1

    print('docparse duplicate cleanup audit: %s' % json.dumps(audit, default=str, sort_keys=True))


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [
        ('docparse', '0002_parseddocument_failure_code'),
        ('oss', '0001_initial'),
    ]

    operations = [
        migrations.RunPython(clean_duplicate_docparse_rows, noop_reverse),
        migrations.CreateModel(
            name='DocumentImportJob',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('status', models.CharField(choices=[('queued', 'Queued'), ('running', 'Running'), ('retrying', 'Retrying'), ('ready', 'Ready'), ('partial_ready', 'Partial ready'), ('failed', 'Failed'), ('interrupted', 'Interrupted'), ('cancelled', 'Cancelled')], db_index=True, default='queued', max_length=32)),
                ('stage', models.CharField(choices=[('validating', 'Validating'), ('downloading', 'Downloading'), ('inspecting', 'Inspecting'), ('extracting', 'Extracting'), ('persisting', 'Persisting'), ('building_draft', 'Building draft'), ('indexing', 'Indexing'), ('completed', 'Completed')], db_index=True, default='validating', max_length=32)),
                ('total_pages', models.IntegerField(default=0)),
                ('processed_pages', models.IntegerField(default=0)),
                ('failed_pages', models.IntegerField(default=0)),
                ('celery_task_id', models.CharField(blank=True, db_index=True, max_length=255)),
                ('worker_id', models.CharField(blank=True, db_index=True, max_length=255)),
                ('retry_count', models.IntegerField(default=0)),
                ('heartbeat_at', models.DateTimeField(blank=True, db_index=True, null=True)),
                ('lease_expires_at', models.DateTimeField(blank=True, db_index=True, null=True)),
                ('error_code', models.CharField(blank=True, db_index=True, max_length=64)),
                ('error_message', models.TextField(blank=True)),
                ('result_payload', models.JSONField(blank=True, default=dict)),
                ('result_storage_key', models.CharField(blank=True, max_length=1024)),
                ('parser_version', models.CharField(default='docparse-job-v1', max_length=64)),
                ('created_at', models.DateTimeField(auto_now_add=True, db_index=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('started_at', models.DateTimeField(blank=True, null=True)),
                ('completed_at', models.DateTimeField(blank=True, null=True)),
                ('file_record', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='document_import_jobs', to='oss.filerecord', verbose_name='源文件')),
                ('parsed_document', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='import_jobs', to='docparse.parseddocument', verbose_name='解析文档')),
            ],
            options={
                'db_table': 'services_docparse_import_job',
                'ordering': ['-created_at'],
                'indexes': [
                    models.Index(fields=['file_record', 'status'], name='services_do_file_re_401ccb_idx'),
                    models.Index(fields=['status', 'stage', 'created_at'], name='services_do_status_893a7e_idx'),
                    models.Index(fields=['lease_expires_at', 'status'], name='services_do_lease_e_0e3180_idx'),
                    models.Index(fields=['celery_task_id'], name='services_do_celery__de136e_idx'),
                ],
                'constraints': [
                    models.UniqueConstraint(condition=models.Q(('status__in', ('queued', 'running', 'retrying'))), fields=('file_record',), name='docparse_import_job_one_active_per_file'),
                ],
            },
        ),
        migrations.AddConstraint(
            model_name='documentpage',
            constraint=models.UniqueConstraint(fields=('document', 'page_number'), name='docparse_page_document_page_uniq'),
        ),
        migrations.AddConstraint(
            model_name='documentchunk',
            constraint=models.UniqueConstraint(fields=('page', 'sequence'), name='docparse_chunk_page_sequence_uniq'),
        ),
    ]
