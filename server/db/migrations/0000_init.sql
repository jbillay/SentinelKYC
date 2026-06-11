CREATE TYPE "public"."run_status" AS ENUM('running', 'done', 'failed', 'not_found');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('initial', 'refresh');--> statement-breakpoint
CREATE TYPE "public"."fragment_kind" AS ENUM('decision', 'audit');--> statement-breakpoint
CREATE TYPE "public"."fragment_status" AS ENUM('ok', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "dossiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_number" text NOT NULL,
	"company_name" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dossiers_company_number_unique" UNIQUE("company_number")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dossier_id" uuid NOT NULL,
	"thread_id" text NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"trigger" "run_trigger" DEFAULT 'initial' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"final_kyc_card" jsonb,
	"final_shareholder_graph" jsonb,
	"final_documents" jsonb,
	"error" text,
	CONSTRAINT "runs_thread_id_unique" UNIQUE("thread_id")
);
--> statement-breakpoint
CREATE TABLE "decision_fragments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" "fragment_kind" NOT NULL,
	"status" "fragment_status" DEFAULT 'ok' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"summary" text,
	"inputs" jsonb,
	"outputs" jsonb,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_dossier_id_dossiers_id_fk" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_fragments" ADD CONSTRAINT "decision_fragments_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;